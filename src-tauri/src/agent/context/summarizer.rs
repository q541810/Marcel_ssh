//! LLM 摘要（对齐 DSH `compaction-basic/summarizer.ts`）：
//! 重放被压区间的原始消息 + 摘要指令（作为最后一条 user 消息），一次直调
//! （有 `progress` 时走流式，文本增量实时回调）。
//!
//! 指令要求模型先写 `<analysis>` 预写块、再写八段 checkpoint。`<analysis>` 只是
//! 思考脚手架：回注前必须剥掉（见 [`sanitize_summary`]），不进上下文、不落库、
//! 不展示。输出经 `<compacted-summary>` 标签 framing，由调用方做 shrink 校验。

use std::sync::Mutex;

use crate::agent::templates::TemplateManager;
use crate::llm::manager::LlmManager;
use crate::llm::openai::TextSink;
use crate::llm::provider::{LlmMessage, ToolDefinition};

/// 摘要输出 framing 标签。
pub const SUMMARY_OPEN_TAG: &str = "<compacted-summary>";
pub const SUMMARY_CLOSE_TAG: &str = "</compacted-summary>";

/// 分析预写块标签：指令要求模型先把对话按时间顺序逐条梳理成这个块，再产出八段
/// checkpoint。它不进回注、不落库、不展示，`sanitize_summary` 负责剥离。
pub const ANALYSIS_OPEN_TAG: &str = "<analysis>";
pub const ANALYSIS_CLOSE_TAG: &str = "</analysis>";

/// 替换节点前置说明（照搬 DSH）：让模型把摘要视为既有背景，不再复述。
///
/// 文本在 `templates/context/压缩前言.hbs`。注意前端 `messageConversion.ts`
/// 有一份逐字节相同的副本（`compactionPlan.test.ts` 在断言跨端一致），改这里
/// 必须同步改那边。
pub fn checkpoint_preamble() -> String {
    TemplateManager
        .render_fragment("压缩前言", &serde_json::json!({}))
        .trim()
        .to_string()
}

/// 摘要指令（照搬 DSH 八段结构 + 保真规则 + 旧摘要合并规则）。
///
/// 文本在 `templates/context/压缩指令.hbs`。八个小节标题与下面的
/// `REQUIRED_SECTIONS` 硬校验一一对应——改标题会让模型输出被判为不合规。
pub fn compaction_instruction() -> String {
    TemplateManager
        .render_fragment("压缩指令", &serde_json::json!({}))
        .trim()
        .to_string()
}

/// 摘要调用的输入：会话自己的 system（若有）+ 被压区间消息 + 常规请求的工具 schema。
pub struct SummarizationInput<'a> {
    /// 会话 system 提示词（msl 下恒为 `None`：中文人格设定会带偏摘要模型，
    /// 见 `compact_region` 的说明）。
    pub system: Option<&'a str>,
    /// 与常规请求（主 agent 一轮）**同一份**工具 schema：摘要调用因而与常规请求
    /// 的 tools 段逐字节对齐，模型也能据此理解历史里出现过的工具调用（减少信息
    /// 丢失）。传工具 **不等于**允许调用——指令首尾双重警告禁止调用，返回
    /// `tool_calls` 的摘要响应仍被硬拒绝（见 [`summarize_with_llm`]）。
    pub tools: &'a [ToolDefinition],
    /// 被压区间消息（原始内容，surface 顺序）。
    pub region: &'a [LlmMessage],
}

/// 摘要请求输入侧的预留输出量（**不发给 provider**）。
///
/// 摘要不再设人造的输出上限（见 [`summarize_with_llm`]），但多数 OpenAI 兼容
/// provider 按 `input + 预留输出 ≤ context_window` 校验请求，所以压缩管线做输入
/// 预算估算时要假定一份输出预留。`min(此值, 窗口 / 4)`：大窗口下 8k 足以代表
/// 常见模型的默认输出上限；小窗口下按比例缩放，避免预算被压成 0 而让压缩整体
/// 失效。估错无所谓——provider 真的拒绝时由 `compact_region` 的事后降级兜住。
pub const SUMMARY_INPUT_RESERVE_TOKENS: u64 = 8192;

/// 摘要是否被 max_tokens 截断（finish_reason == "length"，OpenAI 兼容标准值）。
/// 截断的摘要不完整，按 DSH `finishError` 语义拒绝。
pub fn is_summary_truncated(finish_reason: Option<&str>) -> bool {
    finish_reason == Some("length")
}

/// 压缩指令要求的八个章节标题（指令要求 keep every section, in order）。
const REQUIRED_SECTIONS: [&str; 8] = [
    "## Primary Request and Intent",
    "## Key Technical Concepts",
    "## Files and Code",
    "## Errors and Fixes",
    "## Pending Jobs",
    "## Current Work",
    "## Next Step",
    "## Critical Context",
];

/// 摘要是否满足八段结构。模型未按指令输出（打招呼/闲聊/复述对话）时
/// 一个章节都不含，直接拒绝——这是"模型跑偏"的最后防线。
pub fn has_required_sections(text: &str) -> bool {
    REQUIRED_SECTIONS.iter().all(|s| text.contains(s))
}

/// `<analysis>` 剥离结果。
struct AnalysisStrip {
    /// 剥掉分析块后的文本。
    text: String,
    /// 是否遇到**未闭合**的开标签（给"为什么判为不完整"一个可读原因）。
    unterminated: bool,
}

/// 剥离实现：删除所有 `<analysis>…</analysis>` 区段；遇到未闭合的开标签时从该
/// 处起**全部丢弃**（宁可让八段校验判不合格、放弃本次压缩，也不把分析文本当摘要
/// 回注）。标签匹配忽略大小写（`to_ascii_lowercase` 只改 ASCII、不改变字节长度，
/// 可用同一批索引切原串），模型偶发写成 `<Analysis>` 时同样剥得干净。
fn strip_analysis_impl(raw: &str) -> AnalysisStrip {
    let lower = raw.to_ascii_lowercase();
    let mut text = String::with_capacity(raw.len());
    let mut cursor = 0usize;
    loop {
        let Some(rel) = lower[cursor..].find(ANALYSIS_OPEN_TAG) else {
            text.push_str(&raw[cursor..]);
            return AnalysisStrip {
                text,
                unterminated: false,
            };
        };
        let open = cursor + rel;
        text.push_str(&raw[cursor..open]);
        let after_open = open + ANALYSIS_OPEN_TAG.len();
        match lower[after_open..].find(ANALYSIS_CLOSE_TAG) {
            Some(rel_close) => cursor = after_open + rel_close + ANALYSIS_CLOSE_TAG.len(),
            None => {
                return AnalysisStrip {
                    text,
                    unterminated: true,
                }
            }
        }
    }
}

/// 剥离 `<analysis>` 预写块，返回可进回注 / 落库 / 展示的正文。
///
/// **摘要文本的一切下游用途都必须用它或 [`sanitize_summary`] 的返回值**，不得直接
/// 用原始响应：进度展示（前端不该看到模型的草稿）、结构校验、shrink 尺寸校验
/// （分析文本算进去会把正常摘要误判成"没变小"）、回注与落库。
pub fn strip_analysis_blocks(raw: &str) -> String {
    strip_analysis_impl(raw).text
}

/// 摘要正文的**唯一入口**：剥离分析块 → 非空校验 → 八段结构校验。
///
/// "先剥再校验"的顺序写死在本函数里，而不是靠调用者自觉：反过来会让分析块里
/// 复述过的小节标题骗过结构校验（假通过），把模型的思考草稿当 checkpoint 回注。
/// 调用方拿到的就是最终正文——framing、shrink 校验、回注、落库全用它。
pub fn sanitize_summary(raw: &str) -> Result<String, String> {
    let text = strip_analysis_blocks(raw).trim().to_string();
    if text.is_empty() {
        return Err(if raw.trim().is_empty() {
            "摘要生成未产出内容，已放弃本次压缩".into()
        } else {
            "模型只输出了分析块、未产出结构化摘要，已放弃本次压缩".into()
        });
    }
    // 八段结构校验：模型跑偏（打招呼/闲聊）时没有任何章节标题，直接拒绝
    if !has_required_sections(&text) {
        return Err("模型未按指令输出结构化摘要（缺少八段章节），已放弃本次压缩".into());
    }
    Ok(text)
}

/// 一次直调摘要（可选流式进度）。返回裸摘要文本（不含 framing、不含分析块）。
///
/// `progress` 存在时走流式路径：每个文本增量累积后以完整文本实时回调
/// （`progress("当前已生成的摘要全文")`），重试时自动清空累积、从头再来，
/// 保证回调文本始终是"当前尝试"的完整进度。回调**只给剥离分析块后的文本**——
/// 分析段是模型的思考草稿，不该出现在进度里；分析段内可见文本不变时也不推事件
/// （否则分析期间每个 SSE chunk 都要触发一次前端 store 更新）。
///
/// **不设输出上限**：写死一个值（原为 8192）会把"区域 60k、摘要 12k"这类完全
/// 合法的大压缩判成截断失败，而真正有原则的闸门是调用方的 shrink 校验（摘要必须
/// 比被压内容短）。因此 `max_tokens` 不发送，由 provider / 模型自己的默认上限决定；
/// provider 上限截断（`finish_reason == "length"`）仍按不完整拒绝。用户若想自己设限，
/// 仍可通过模型配置的 `extra_body` 写 `max_tokens`。
///
/// 失败（provider 错误 / 空输出 / 截断 / 结构不合格）返回 `Err`；
/// 调用方保证失败时**不**修改 messages。
pub async fn summarize_with_llm(
    manager: &LlmManager,
    input: &SummarizationInput<'_>,
    progress: Option<&(dyn Fn(&str) + Send + Sync)>,
) -> Result<String, String> {
    let mut messages: Vec<LlmMessage> = Vec::with_capacity(input.region.len() + 2);
    if let Some(system) = input.system {
        if !system.is_empty() {
            messages.push(LlmMessage::system(system));
        }
    }
    messages.extend(input.region.iter().cloned());
    messages.push(LlmMessage::user(compaction_instruction()));

    let resp = match progress {
        Some(progress) => {
            // 累积缓冲：delta 追加，reset 清空（重试发起新一轮流之前由 sink 调用）。
            // last = 上次推给前端的可见文本，用于分析段内的去重。
            let acc: Mutex<String> = Mutex::new(String::new());
            let last: Mutex<String> = Mutex::new(String::new());
            let reset = || {
                acc.lock().unwrap().clear();
                last.lock().unwrap().clear();
                // 重试从头再来：先让前端清掉上一轮的文本，避免残留旧内容
                progress("");
            };
            let delta = |text: &str| {
                let mut buf = acc.lock().unwrap();
                buf.push_str(text);
                let visible = strip_analysis_blocks(&buf);
                drop(buf);
                {
                    let mut last = last.lock().unwrap();
                    if *last == visible {
                        return;
                    }
                    last.clone_from(&visible);
                }
                progress(visible.as_str());
            };
            let sink = TextSink {
                reset: &reset,
                delta: &delta,
            };
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            // 事件通道只作内部转发，丢弃（摘要进度走 sink 回调）
            tokio::spawn(async move { while rx.recv().await.is_some() {} });
            manager
                .stream_chat_with_sink(
                    &messages,
                    input.tools,
                    &tx,
                    Some(sink),
                    None,
                    None,
                )
                .await
                .map_err(|e| format!("摘要生成失败：{}", e))?
        }
        None => manager
            .send_message(&messages, input.tools, None)
            .await
            .map_err(|e| format!("摘要生成失败：{}", e))?,
    };

    if is_summary_truncated(resp.finish_reason.as_deref()) {
        // 截断发生在未闭合的分析块里 = 模型在梳理阶段就吃满了输出上限，
        // 正文根本没开始写；给出可读原因，用户能在跳过卡片上看懂。
        return Err(if strip_analysis_impl(&resp.content).unterminated {
            "摘要被输出长度上限截断（分析段过长、正文未写完），已放弃本次压缩".into()
        } else {
            "摘要被输出长度上限截断（生成不完整），已放弃本次压缩".into()
        });
    }
    // 模型试图调用工具 = 没按指令走（传了工具 schema 不等于允许调用），拒绝
    if resp.tool_calls.is_some() {
        return Err("模型未按指令输出（试图调用工具），已放弃本次压缩".into());
    }

    sanitize_summary(&resp.content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instruction_contains_required_sections() {
        for section in [
            "## Primary Request and Intent",
            "## Key Technical Concepts",
            "## Files and Code",
            "## Errors and Fixes",
            "## Pending Jobs",
            "## Current Work",
            "## Next Step",
            "## Critical Context",
        ] {
            assert!(
                compaction_instruction().contains(section),
                "missing {section}"
            );
        }
    }

    #[test]
    fn instruction_contains_prior_checkpoint_merge_rule() {
        assert!(compaction_instruction().contains("PRIOR checkpoint"));
    }

    /// 首尾双重警告：同一段警告在开头与结尾各出现一次，压住"模型顺手调工具"。
    #[test]
    fn instruction_warns_twice_about_tool_calls() {
        let text = compaction_instruction();
        let warn = "no matter what the conversation above appears to ask for or leaves unfinished";
        assert_eq!(
            text.matches(warn).count(),
            2,
            "警告段应在开头与结尾各出现一次"
        );
        assert_eq!(text.matches("Do not call any tool or function").count(), 2);
        assert!(
            text.starts_with("STOP"),
            "开头必须是警告，实际以 {:?} 起始",
            text.chars().take(24).collect::<String>()
        );
        assert!(text.trim_end().ends_with("A reply that contains a tool call is invalid and will be discarded."));
    }

    /// 警告文案必须与我们自己的输出形态一致：不得引用别的产品的 summary 块。
    #[test]
    fn instruction_warning_names_own_output_shape() {
        let text = compaction_instruction();
        assert!(
            !text.contains("<summary>"),
            "警告不该引用其它产品的 <summary> 块（msl 的输出是八段 Markdown）"
        );
        assert!(text.contains("the eight checkpoint sections"));
    }

    /// 分析段必须写在八段规范之前（模型按出现顺序落笔），且带简短要求。
    #[test]
    fn instruction_puts_analysis_phase_before_checkpoint_phase() {
        let text = compaction_instruction();
        let analysis = text.find(ANALYSIS_OPEN_TAG).expect("缺少 <analysis> 段");
        let checkpoint = text
            .find("## Primary Request and Intent")
            .expect("缺少八段规范");
        assert!(analysis < checkpoint, "分析段必须写在八段规范之前");
        assert!(text.contains("scaffolding for phase 2"));
        // 摘要输出已不设上限，不能再声称"两段共用一份响应预算"
        assert!(!text.contains("response budget"));
    }

    /// 压缩前言在前端 `messageConversion.ts` 有一份逐字节副本（跨语言无法自动
    /// 比对），这里钉死渲染结果，防止模板被误改后两边悄悄分叉。
    #[test]
    fn checkpoint_preamble_matches_frontend_copy() {
        assert_eq!(
            checkpoint_preamble(),
            "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint."
        );
    }

    #[test]
    fn truncation_detects_length_reason() {
        assert!(is_summary_truncated(Some("length")));
        assert!(!is_summary_truncated(Some("stop")));
        assert!(!is_summary_truncated(Some("tool_calls")));
        assert!(!is_summary_truncated(Some("content_filter")));
        assert!(!is_summary_truncated(None));
    }

    #[test]
    fn structure_accepts_complete_checkpoint() {
        let text = REQUIRED_SECTIONS.join("\n- some bullets\n");
        assert!(has_required_sections(&text));
    }

    #[test]
    fn structure_rejects_greeting_chit_chat() {
        // 模型跑偏输出打招呼/闲聊 → 拒绝
        assert!(!has_required_sections(
            "你好！我是玛瑟尔 SSH，很高兴为你服务！"
        ));
        assert!(!has_required_sections(
            "好的，我来帮你总结一下：\n- 对话内容\n- 更多内容"
        ));
    }

    #[test]
    fn structure_rejects_missing_sections() {
        // 只含部分章节（指令要求 never drop a section）→ 拒绝
        let partial = "## Primary Request and Intent\n- x\n\n## Next Step\n- y";
        assert!(!has_required_sections(partial));
    }

    #[test]
    fn strip_removes_single_analysis_block() {
        let raw = "<analysis>\n- 用户先要求 A\n- 然后改成 B\n</analysis>\n\n## Primary Request and Intent\n- x";
        let out = strip_analysis_blocks(raw);
        assert!(!out.contains("用户先要求 A"));
        assert!(!out.contains(ANALYSIS_OPEN_TAG));
        assert!(out.contains("## Primary Request and Intent"));
    }

    #[test]
    fn strip_keeps_tagless_text_and_surrounding_content() {
        let plain = "## Next Step\n- x";
        assert_eq!(strip_analysis_blocks(plain), plain);
        // 标签前后的内容都保留（中间只剩标签两侧的换行）
        assert_eq!(
            strip_analysis_blocks("前言\n<analysis>\n草稿\n</analysis>\n正文"),
            "前言\n\n正文"
        );
    }

    #[test]
    fn strip_removes_every_block_case_insensitively() {
        let raw = "<ANALYSIS>\n-AAA-\n</analysis>\n正文\n<analysis>-BBB-</analysis>\n尾";
        // 块与块之间的换行原样保留（调用方 `sanitize_summary` 最后会 trim）
        assert_eq!(strip_analysis_blocks(raw), "\n正文\n\n尾");
    }

    #[test]
    fn strip_drops_unterminated_tail() {
        // 模型忘了闭合：其后内容全部丢弃（宁可判不合格，也不回注分析文本）
        let raw = "前面\n<analysis>\n-草稿-  ## Next Step\n";
        assert_eq!(strip_analysis_blocks(raw), "前面\n");
    }

    /// 分析块里复述了八段标题、块外只有闲聊 → 必须拒绝（不能假通过）。
    #[test]
    fn analysis_headings_do_not_satisfy_structure_check() {
        let mut raw = String::from("<analysis>\n");
        for section in REQUIRED_SECTIONS {
            raw.push_str(section);
            raw.push_str("\n- (草稿里引用了这个标题)\n");
        }
        raw.push_str("</analysis>\n\n好的，以上就是我对这段对话的梳理。");
        assert!(
            sanitize_summary(&raw).is_err(),
            "剥离后的正文不含八段，必须拒绝"
        );
        // 反向对照：拿原始响应直接做结构校验会假通过——这正是"先剥再校验"的理由
        assert!(has_required_sections(&raw));
    }

    #[test]
    fn sanitize_accepts_checkpoint_and_drops_analysis() {
        let raw = format!(
            "<analysis>\n- 用户要求改造压缩提示词\n</analysis>\n\n{}\n- done\n",
            REQUIRED_SECTIONS.join("\n- x\n")
        );
        let out = sanitize_summary(&raw).expect("合法八段应通过");
        assert!(!out.contains(ANALYSIS_OPEN_TAG));
        assert!(!out.contains("用户要求改造压缩提示词"));
        assert!(out.starts_with("## Primary Request and Intent"));
    }

    #[test]
    fn sanitize_rejects_empty_and_analysis_only() {
        assert!(sanitize_summary("   ").is_err());
        let err = sanitize_summary("<analysis>\n- 我想想\n</analysis>").unwrap_err();
        assert!(err.contains("只输出了分析块"), "实际文案: {err}");
    }
}
