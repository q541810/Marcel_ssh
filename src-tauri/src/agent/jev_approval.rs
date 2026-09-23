//! Jev 引擎的命令审批——`CommandApprover` 的第二个实现。
//!
//! 走 TypeSafe 的 Jev（System One 决策模型），与 chat 引擎（`model_approval.rs`
//! 的 `ModelApprover`）在**判定语义上完全等价**：同样是 approve /
//! route_to_human / block 三档，权限边界一样（只能判定、不能改写命令，
//! 不能放行静态风险评估要求人审的命令）。差异只有三点：
//!
//! 1. **速度与成本**：一次 POST 拿回 JSON，不像 chat 路径要拉整个 SSE 流再丢掉。
//! 2. **判定形态**：三档判定是一个 Jev `Choice`，返回带概率分布，不是自由文本
//!    再解析 JSON——所以没有"模型返回未知决策"这类解析失败。
//! 3. **理由形态**：Jev **不生成文本**，写不出「这条命令会覆盖 /etc/nginx」这种
//!    句子。理由改用一组预设的 `Noul`（是非判断），把命中的标签拼成列表。
//!    标签文本由本模块的常量给出，因此文案完全可控、可测、可翻译，
//!    不受模型语言能力影响。
//!
//! 官方契约见 <https://docs.typesafe.ai/api>、<https://docs.typesafe.ai/primitives>。

use async_trait::async_trait;
use serde_json::{json, Map, Value};

use crate::agent::model_approval::{
    recent_turns, ApprovalJudgement, CommandApprover, ModelApprovalDecision,
};
use crate::agent::templates::TemplateManager;
use crate::error::AppError;
use crate::llm::jev::{JevClient, JevConfig, JevResponse};
use crate::llm::provider::LlmMessage;

/// 三档判定那个 Choice 的问题 id。
///
/// 只在本模块内用于取答案——官方明确「question ids are for your code. They are
/// not sent to the model」，所以问题本身必须写在 `instructions` 里自包含。
const DECISION_ID: &str = "decision";

/// 三档选项的 key。它们既发给模型（作为 `criteria` 的键），也是我们映射回
/// `ModelApprovalDecision` 的锚点，所以**不允许用户自定义**：改了键就映射不回来。
const OPT_APPROVE: &str = "approve";
const OPT_ROUTE: &str = "route_to_human";
const OPT_BLOCK: &str = "block";

/// 判定某条理由是否成立（Noul 值）的阈值。
///
/// 官方对阈值选择的说法是「取决于判断错的代价」：这里的标签只是**提示信息**，
/// 多标一条的代价是用户多看一眼，漏标的代价是用户少一条决策依据——两者都不
/// 影响命令是否执行，所以取中性的 0.5，不另开设置项。
const REASON_THRESHOLD: f64 = 0.5;

/// 一条理由探针：一个 Noul 问题 + 命中时展示的中文标签。
///
/// 官方推荐的形态就是「一个标签一个 Noul，当多个可能同时成立时」
/// （"use one per label when several may apply"）——因为 Noul 只回一个数字，
/// 多种情况并存时必须拆成多个独立问题。
struct ReasonProbe {
    /// 问题 id（不发给模型，只用于取答案）。
    id: &'static str,
    /// 发给模型的英文/中文问题。
    instructions: &'static str,
    /// 命中后拼进理由列表的中文标签。
    label: &'static str,
}

/// 理由探针集。
///
/// 这些维度是按「用户看到一条被拦下的命令时，最想知道什么」选的：它动的是什么
/// （数据 / 系统配置 / 凭据）、能不能回头（不可逆）、以及是不是他本来要的
/// （超出诉求）。刻意保持少量且相互独立——官方要求每个问题都是「一个有知识的人
/// 一秒内能给出的判断」，宽泛的问题（"这条命令危险吗"）会退化成瞎猜。
const REASON_PROBES: &[ReasonProbe] = &[
    ReasonProbe {
        id: "deletes_data",
        instructions: "这条命令会删除或覆盖数据吗？（含清空目录、覆盖已有文件、删除数据表）",
        label: "会删除或覆盖数据",
    },
    ReasonProbe {
        id: "changes_system",
        instructions: "这条命令会改变整台机器的全局状态吗？（服务、用户、防火墙、挂载、权限这类）",
        label: "会改动系统级配置或权限",
    },
    ReasonProbe {
        id: "touches_secrets",
        instructions: "这条命令会读取、修改或外传凭据、密钥、访问令牌之类的敏感信息吗？",
        label: "会接触凭据或密钥",
    },
    ReasonProbe {
        id: "irreversible",
        instructions: "这条命令的影响不可撤销吗？（删除、覆盖、格式化这类无法回滚的操作）",
        label: "影响不可撤销",
    },
    ReasonProbe {
        id: "beyond_task",
        instructions: "这条命令超出用户当前诉求的范围吗？（用户没要求，也与手头任务无关）",
        label: "超出用户当前诉求",
    },
];

/// Jev 引擎的审批者。
pub(crate) struct JevApprover {
    client: JevClient,
    /// 用户在设置里自定义的判据（空 = 用内置 `审批Jev.hbs`）。
    ///
    /// 与 chat 引擎的 `model_approval_prompt` **分开存放**是刻意的：chat 的
    /// 自定义提示词通常包含「输出严格的 JSON {...}」这类格式要求，喂给不生成
    /// 文本的 Jev 会变成噪音指令、静默劣化判定质量。两个引擎的判据形状不同，
    /// 就不能共用一个输入框。
    custom_instructions: String,
    plan_mode: bool,
}

impl JevApprover {
    pub(crate) fn new(
        config: JevConfig,
        custom_instructions: String,
        plan_mode: bool,
    ) -> Result<Self, AppError> {
        let client = JevClient::new(config).map_err(AppError::from)?;
        Ok(Self {
            client,
            custom_instructions,
            plan_mode,
        })
    }

    /// 组装本次判定用的 `instructions`。
    ///
    /// Plan 模式追加段复用 chat 引擎那份 `审批规划.hbs`：它是纯约束描述、
    /// 不含任何输出格式，所以两个引擎可以共用同一句话，不必维护第二份
    /// 「Plan 模式不得改系统」的规则（护栏测试见 `templates.rs`）。
    fn instructions(&self) -> String {
        let mgr = TemplateManager;
        let mut text = if self.custom_instructions.is_empty() {
            mgr.render_approval_jev()
        } else {
            self.custom_instructions.clone()
        };
        if self.plan_mode {
            let plan = mgr.render_approval_plan();
            if !plan.is_empty() {
                text.push('\n');
                text.push_str(&plan);
            }
        }
        text
    }
}

#[async_trait]
impl CommandApprover for JevApprover {
    async fn evaluate(
        &self,
        command: &str,
        recent_messages: &[LlmMessage],
    ) -> Result<ApprovalJudgement, AppError> {
        // 选了 Jev 却没配 key：明确报错，**不回退到会话模型**。静默回退会让用户
        // 以为自己受 Jev 保护，其实没有——这类"以为有保护其实没有"比直接失败糟。
        if !self.client.config().has_key() {
            return Err(AppError::Config(
                "命令审批引擎选了 Jev，但未配置 TypeSafe API Key。\
                 请到「设置 → Agent → 命令模型审批」填写，或把引擎改回「跟随会话模型」。"
                    .to_string(),
            ));
        }

        let state = build_state(command, recent_messages);
        let questions = build_questions(&self.instructions());

        // 取消信号：与 chat 引擎现状一致（`ModelApprover` 也传 `None`），
        // 即审批调用本身不响应停止；重试等待的上限是 `max_retries × 延迟`。
        // 这里保留该参数是为了让客户端与 chat 路径共用同一套重试代码形状。
        let resp = self
            .client
            .ask(&state, questions, &validate_response, None)
            .await
            .map_err(AppError::from)?;

        map_judgement(&resp)
    }
}

/// 构造结构化 state。
///
/// 官方对 state 的建议是「用对象，让每一部分有描述性的名字、关系清楚」
/// （"Use an object for most requests so each part of the state has a descriptive
/// name and its relationships remain clear"），并且问题里用反引号路径指回来。
/// 所以这里**不把上下文拼成一个大字符串**——那正是 chat 模型的做法，会让模型
/// 分不清哪段是用户意图、哪段是待审命令。
fn build_state(command: &str, messages: &[LlmMessage]) -> Value {
    let conversation: Vec<Value> = recent_turns(messages)
        .iter()
        .map(|t| json!({ "role": t.role, "content": t.content }))
        .collect();
    json!({
        "command": command,
        "conversation": conversation,
    })
}

/// 三档判定的选项定义。
///
/// 官方 `advanced.md` 专门讲了「选项描述可以是对象」，并列了三个字段正是
/// 划边界用的：`what`（覆盖什么）、`not_for`（不覆盖什么）、`examples`。
/// 三档审批的难点全在边界上（approve 与 route_to_human 之间最容易糊），
/// 所以这里用结构化描述而不是一句话。
fn build_criteria() -> Value {
    json!({
        OPT_APPROVE: {
            "what": "这条命令是安全的，可以直接执行，不需要打扰用户。",
            "not_for": "任何你不确定、或用户应当知情后才执行的情况。",
            "examples": [
                "只读命令：列目录、读文件、查看进程与端口状态",
                "用户明确要求过的构建、测试、启动服务"
            ]
        },
        OPT_ROUTE: {
            "what": "这条命令本身不算危险，但需要用户点头才能执行。",
            "not_for": "明显安全到无需询问的命令；也不要用于你确信必须拦下的命令。",
            "examples": [
                "会改动文件、装依赖、重启服务，但范围清楚、用户可以判断",
                "与用户诉求相关，但影响面需要用户确认"
            ]
        },
        OPT_BLOCK: {
            "what": "这条命令不能执行，应当直接阻止。",
            "not_for": "仅仅看起来有点重的命令——语义上安全就不要阻止。",
            "examples": [
                "破坏性且不可逆：清空系统目录、写块设备、格式化",
                "与用户诉求无关的高风险操作",
                "读取或外传凭据、密钥，而用户并未要求"
            ]
        }
    })
}

/// 组装 `questions`：一个 Choice（三档判定）+ 一组 Noul（理由探针）。
///
/// 官方强调「一次请求里把可能用到的判断都问上」，因为所有问题并行评估、
/// 互不可见，加问题几乎不增加响应时间。所以理由探针和判定一起问，
/// 不需要第二次往返。
fn build_questions(instructions: &str) -> Value {
    let mut questions = Map::new();
    questions.insert(
        DECISION_ID.to_string(),
        json!({
            "type": "choice",
            "instructions": instructions,
            "criteria": build_criteria(),
        }),
    );
    for probe in REASON_PROBES {
        questions.insert(
            probe.id.to_string(),
            json!({
                "type": "noul",
                "instructions": probe.instructions,
            }),
        );
    }
    Value::Object(questions)
}

/// 响应可用性判据，喂给 `JevClient::ask`。
///
/// 不通过就计入可重试预算（HTTP 200 但答案不可用 = chat 路径的「哑火」），
/// 预算耗尽后变成 `LlmError::ParseError`，最终按现状 fail-closed 拦下命令。
fn validate_response(resp: &JevResponse) -> Result<(), String> {
    match resp.choice(DECISION_ID) {
        None => Err(format!(
            "Jev 响应缺少可用的 `{DECISION_ID}` 答案（answers: {:?}）",
            resp.answers.keys().collect::<Vec<_>>()
        )),
        Some((choice, _)) if !is_known_option(choice) => {
            Err(format!("Jev 返回了 criteria 之外的决策 {choice:?}"))
        }
        Some(_) => Ok(()),
    }
}

fn is_known_option(choice: &str) -> bool {
    matches!(choice, OPT_APPROVE | OPT_ROUTE | OPT_BLOCK)
}

/// 把 Jev 的答案映射成判定结果。
fn map_judgement(resp: &JevResponse) -> Result<ApprovalJudgement, AppError> {
    let (choice, confidence) = resp
        .choice(DECISION_ID)
        .ok_or_else(|| AppError::Llm(format!("Jev 响应缺少可用的 `{DECISION_ID}` 答案")))?;

    let decision = match choice {
        // Approve 不带理由：与 chat 引擎语义一致（放行没有需要解释的问题点）。
        OPT_APPROVE => ModelApprovalDecision::Approve,
        OPT_ROUTE => ModelApprovalDecision::RouteToHuman(collect_reasons(resp)),
        OPT_BLOCK => ModelApprovalDecision::Block(collect_reasons(resp)),
        other => {
            return Err(AppError::Llm(format!(
                "Jev 返回了 criteria 之外的决策 {other:?}"
            )))
        }
    };

    Ok(ApprovalJudgement {
        decision,
        // ⚠️ 官方定义：这是「概率分布的集中程度」，不是「判定正确的概率」。
        // 仅用于展示，不参与任何判定分支。
        confidence: confidence.map(|c| c as f32),
        engine: "jev",
    })
}

/// 把 Noul 值超过阈值的探针标签拼成理由列表。
fn collect_reasons(resp: &JevResponse) -> Vec<String> {
    REASON_PROBES
        .iter()
        .filter(|p| {
            resp.noul(p.id)
                .map(|v| v >= REASON_THRESHOLD)
                .unwrap_or(false)
        })
        .map(|p| p.label.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::provider::LlmRole;

    fn msg(role: LlmRole, content: &str) -> LlmMessage {
        LlmMessage {
            role,
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
            image_paths: None,
            finish_reason: None,
            db_id: None,
            db_id_known: false,
        }
    }

    fn resp_from(value: Value) -> JevResponse {
        serde_json::from_value(value).unwrap()
    }

    // ── state 构造 ───────────────────────────────────────────────

    #[test]
    fn state_is_structured_not_a_concatenated_string() {
        let messages = vec![
            msg(LlmRole::System, "系统提示词不许外泄"),
            msg(LlmRole::User, "帮我清理 /tmp 下的构建产物"),
            msg(LlmRole::Assistant, "好的，我先看看"),
        ];
        let state = build_state("rm -rf /tmp/build", &messages);

        // 命令与对话是两个有名字的字段，而不是拼在一起的一坨文本。
        assert_eq!(state["command"], "rm -rf /tmp/build");
        let convo = state["conversation"].as_array().unwrap();
        assert_eq!(convo.len(), 2, "system 消息不得进入审批 state");
        assert_eq!(convo[0]["role"], "user");
        assert_eq!(convo[0]["content"], "帮我清理 /tmp 下的构建产物");
        assert_eq!(convo[1]["role"], "assistant");
        assert!(
            !state.to_string().contains("系统提示词"),
            "system prompt 不得泄进审批请求"
        );
    }

    #[test]
    fn state_without_context_has_empty_conversation() {
        let state = build_state("ls", &[]);
        assert_eq!(state["conversation"].as_array().unwrap().len(), 0);
        assert_eq!(state["command"], "ls");
    }

    #[test]
    fn state_reuses_the_shared_truncation_caps() {
        // 与 chat 引擎共用 `recent_turns` 的上限，而不是各留一份。
        let long_tool = "x".repeat(5000);
        let state = build_state("ls", &[msg(LlmRole::User, "任务"), msg(LlmRole::Tool, &long_tool)]);
        let tool_entry = &state["conversation"].as_array().unwrap()[1];
        let content = tool_entry["content"].as_str().unwrap();
        assert!(content.contains("已截断"), "工具输出必须按上限截断");
        assert!(content.len() < long_tool.len());
    }

    // ── questions 构造 ───────────────────────────────────────────

    #[test]
    fn questions_contain_decision_choice_and_all_reason_probes() {
        let q = build_questions("判断这条命令");
        assert_eq!(q[DECISION_ID]["type"], "choice");
        assert_eq!(q[DECISION_ID]["instructions"], "判断这条命令");

        for probe in REASON_PROBES {
            assert_eq!(q[probe.id]["type"], "noul", "缺少理由探针 {}", probe.id);
            assert!(
                q[probe.id]["instructions"].as_str().unwrap().len() > 5,
                "理由探针 {} 的问题不能为空——id 不发给模型，语义只能写在 instructions 里",
                probe.id
            );
        }
        // 一次请求问全，不产生第二次往返。
        assert_eq!(q.as_object().unwrap().len(), REASON_PROBES.len() + 1);
    }

    #[test]
    fn decision_criteria_keys_match_the_mapping_anchors() {
        let criteria = build_criteria();
        let keys: Vec<&str> = criteria.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        assert!(keys.contains(&OPT_APPROVE));
        assert!(keys.contains(&OPT_ROUTE));
        assert!(keys.contains(&OPT_BLOCK));
        assert_eq!(keys.len(), 3, "三档之外不得有第四个选项");
    }

    #[test]
    fn criteria_boundaries_are_structured() {
        // 官方 advanced.md：选项描述用对象划边界（what / not_for / examples）。
        let criteria = build_criteria();
        for key in [OPT_APPROVE, OPT_ROUTE, OPT_BLOCK] {
            let opt = &criteria[key];
            assert!(opt["what"].as_str().is_some(), "{key} 缺 what");
            assert!(opt["not_for"].as_str().is_some(), "{key} 缺 not_for");
            assert!(!opt["examples"].as_array().unwrap().is_empty(), "{key} 缺 examples");
        }
    }

    // ── instructions 组装 ────────────────────────────────────────

    fn approver(custom: &str, plan_mode: bool) -> JevApprover {
        JevApprover::new(
            JevConfig::new("test-key".into(), String::new(), Default::default()),
            custom.to_string(),
            plan_mode,
        )
        .expect("Jev 客户端构造应成功")
    }

    #[test]
    fn instructions_default_to_builtin_template() {
        let text = approver("", false).instructions();
        assert!(text.contains("command"), "内置判据应说明要判断哪个字段");
        assert!(text.contains("只能判定"));
    }

    #[test]
    fn instructions_plan_mode_appends_shared_plan_fragment() {
        let text = approver("", true).instructions();
        // 复用 chat 引擎那份 Plan 约束，而不是新写一份。
        assert!(text.contains("Plan 模式"));
        assert!(text.contains("只能判定"), "追加不该覆盖原判据");
    }

    #[test]
    fn custom_instructions_override_builtin_but_keep_plan_fragment() {
        let text = approver("我的自定义判据", true).instructions();
        assert!(text.starts_with("我的自定义判据"));
        assert!(text.contains("Plan 模式"));
        assert!(!text.contains("command"), "自定义时应覆盖内置文本");
    }

    #[test]
    fn non_plan_mode_has_no_plan_text() {
        let text = approver("", false).instructions();
        assert!(!text.contains("Plan 模式"));
    }

    // ── 响应校验与映射 ───────────────────────────────────────────

    #[test]
    fn validate_accepts_each_known_option() {
        for option in [OPT_APPROVE, OPT_ROUTE, OPT_BLOCK] {
            let resp = resp_from(json!({
                "answers": { DECISION_ID: {"type": "choice", "choice": option} }
            }));
            assert!(validate_response(&resp).is_ok(), "{option} 应被接受");
        }
    }

    #[test]
    fn validate_rejects_missing_and_unknown_decision() {
        let missing = resp_from(json!({"answers": {}}));
        assert!(validate_response(&missing).is_err());

        // 官方承诺「答案被约束在你给的可选值内」，出现集外值说明出了问题，
        // 应计入重试预算而不是当成合法决策。
        let unknown = resp_from(json!({
            "answers": { DECISION_ID: {"type": "choice", "choice": "maybe"} }
        }));
        assert!(validate_response(&unknown).is_err());

        // 同 id 但类型不对（返回了 noul）
        let wrong_type = resp_from(json!({
            "answers": { DECISION_ID: {"type": "noul", "noul": 1.0} }
        }));
        assert!(validate_response(&wrong_type).is_err());
    }

    #[test]
    fn maps_approve_without_reasons() {
        let resp = resp_from(json!({
            "answers": {
                DECISION_ID: {"type": "choice", "choice": "approve", "confidence": 0.97},
                "deletes_data": {"type": "noul", "noul": 0.99}
            }
        }));
        let j = map_judgement(&resp).unwrap();
        assert_eq!(j.decision, ModelApprovalDecision::Approve);
        assert_eq!(j.confidence, Some(0.97));
        assert_eq!(j.engine, "jev");
        // 放行不携带理由：与 chat 引擎语义一致（"approve, reasons 可为空数组"）。
        // 即使探针命中了也不展示——探针是给拦下时解释用的。
        assert!(!matches!(j.decision, ModelApprovalDecision::Block(_)));
    }

    #[test]
    fn maps_route_and_block_with_labels() {
        let resp = resp_from(json!({
            "answers": {
                DECISION_ID: {"type": "choice", "choice": "route_to_human", "confidence": 0.41},
                "deletes_data": {"type": "noul", "noul": 0.93},
                "changes_system": {"type": "noul", "noul": 0.02},
                "irreversible": {"type": "noul", "noul": 0.88}
            }
        }));
        let j = map_judgement(&resp).unwrap();
        // 标签是中文常量，不是模型生成的文本。
        assert_eq!(
            j.decision,
            ModelApprovalDecision::RouteToHuman(vec![
                "会删除或覆盖数据".to_string(),
                "影响不可撤销".to_string(),
            ])
        );
        assert_eq!(j.confidence, Some(0.41));
    }

    #[test]
    fn confidence_absent_is_none_not_zero() {
        let resp = resp_from(json!({
            "answers": { DECISION_ID: {"type": "choice", "choice": "approve"} }
        }));
        let j = map_judgement(&resp).unwrap();
        assert_eq!(j.confidence, None, "没有 confidence 不得伪造成 0");
    }

    #[test]
    fn map_judgement_errors_on_unknown_option() {
        let resp = resp_from(json!({
            "answers": { DECISION_ID: {"type": "choice", "choice": "nope"} }
        }));
        assert!(map_judgement(&resp).is_err());
    }

    #[test]
    fn reasons_respect_threshold_and_include_boundary() {
        let resp = resp_from(json!({
            "answers": {
                DECISION_ID: {"type": "choice", "choice": "block"},
                "deletes_data": {"type": "noul", "noul": 0.5},      // 恰好等于阈值 → 命中
                "changes_system": {"type": "noul", "noul": 0.4999}, // 略低于 → 不命中
                "touches_secrets": {"type": "noul", "noul": 1.0},
                "irreversible": {"type": "noul", "noul": 0.0},
                // beyond_task 缺失 → 不命中且不 panic
            }
        }));
        let j = map_judgement(&resp).unwrap();
        assert_eq!(
            j.decision,
            ModelApprovalDecision::Block(vec![
                "会删除或覆盖数据".to_string(),
                "会接触凭据或密钥".to_string(),
            ])
        );
    }

    #[test]
    fn no_probe_hit_yields_empty_reasons() {
        let resp = resp_from(json!({
            "answers": {
                DECISION_ID: {"type": "choice", "choice": "route_to_human"},
                "deletes_data": {"type": "noul", "noul": 0.01},
                "changes_system": {"type": "noul", "noul": 0.0},
                "touches_secrets": {"type": "noul", "noul": 0.0},
                "irreversible": {"type": "noul", "noul": 0.0},
                "beyond_task": {"type": "noul", "noul": 0.1},
            }
        }));
        let j = map_judgement(&resp).unwrap();
        // 空列表是合法结果（dispatcher 会回落成通用文案），不得 panic。
        assert_eq!(j.decision, ModelApprovalDecision::RouteToHuman(vec![]));
    }
}
