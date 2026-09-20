use serde::{Deserialize, Serialize};

/// Agent operation mode — determines how much autonomy the agent has.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AgentMode {
    /// Plan mode — AI may invoke a limited set of read-oriented tools
    /// (read_file, list_directory, search_files, system_info, connection_info,
    /// bash, ask_user, web_search, http_get, skills) to research
    /// and plan. No write/edit/create tools. Plugin and MCP tools are not
    /// registered. Command execution is gated by allow/deny lists.
    Plan,
    /// AI may invoke tools; command execution is gated by allow/deny lists
    /// configured in `AgentSettings`.
    Agent,
    /// Fully autonomous — AI executes all tool calls without confirmation.
    Auto,
}

impl AgentMode {
    /// 设置里的字符串（`settings.default_agent_mode`，前端切换模式时经
    /// `taskStore.setMode` 写入）→ 模式。未知值回落 `Agent`（与设置默认值一致）、
    /// 不报错：模式只决定取哪套工具清单，不改变安全边界（审批与风险评估各自独立）。
    pub fn from_settings_str(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "plan" => AgentMode::Plan,
            "auto" => AgentMode::Auto,
            _ => AgentMode::Agent,
        }
    }
}

/// Current status of the agent runtime.
///
/// 每个变体都必须能被 `is_running()` 的 `match` 归类（那个 `match` 不写 `_ =>`，
/// 保证新增变体时编译失败）。此前这里还有一个 `Idle` 占位变体，从未被写入过 ——
/// 任务构造时即 `Planning`（见 `AgentManager::spawn`），停止走 `Cancelled`；
/// 它唯一的作用是让人以为还有一个「空闲」阶段，已于 2026-09-19 删除。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AgentStatus {
    Planning,
    Executing,
    WaitingApproval,
    Completed,
    Failed,
    Cancelled,
}

impl AgentStatus {
    /// 任务是否仍在运行（尚未到达终态）。
    ///
    /// 这是「这个任务还在不在跑」的**唯一**判定入口，同时也是**编译期穷尽的
    /// 分类点**：下面的 `match` 不写 `_ =>` 分支，给 `AgentStatus` 新增状态位时
    /// 它必然编译失败，逼设计者回答「新状态算运行中还是终态」。
    ///
    /// 这一点很关键 —— 谓词本身如果用 `matches!` 就**不参与穷尽性检查**，只靠
    /// 测试里手写一份变体数组是拦不住的（数组漏掉新变体，测试照样全绿）。
    ///
    /// 此前这组判定被抄在四处：`multi_host` 的拉起竞态防御、`plan_handler` 的降级
    /// 判断、`agent_compact` 的 busy 守卫（这三处抄的是「运行中」三变体），以及
    /// `manager` 的终态清理（抄的是「终态」三变体）。
    pub fn is_running(&self) -> bool {
        match self {
            Self::Planning | Self::Executing | Self::WaitingApproval => true,
            Self::Completed | Self::Failed | Self::Cancelled => false,
        }
    }

    /// 任务是否已到终态（不会再变化）。
    ///
    /// 实现是取反：目前**每个**状态非运行即终态，所以等价。但要留意取反的代价 ——
    /// 将来若出现「既非运行中也非终态」的状态（暂停 / 排队），作者在
    /// `is_running()` 的 `match` 里只能回答 true/false，而答 `false` 会被这里
    /// 当成终态（`prune_terminal_tasks` 会把还在跑的任务剪掉）。真到那天请把分类
    /// 改回三态（Running / Terminal / Neither），别硬塞进 `false` 臂。
    pub fn is_terminal(&self) -> bool {
        !self.is_running()
    }

    /// 任务是否**因取消而**终止。
    ///
    /// 和 `is_terminal()` 不是一回事：`Failed` 也是终态。它回答的是「是不是这一个
    /// 变体」，所以**故意不写成穷尽 match** —— 新增状态位时这里没有决定要做
    /// （不像 `is_running`，那里必须回答新状态属于哪一类）。
    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled)
    }
}

/// 一个「回合」（一条 user 消息起的连续消息段）的收尾状态。
///
/// 它是「这一轮到底是怎么停下来的」的**唯一来源**，记录在回合首条 user 消息
/// 行上（`messages.turn_state`）。为什么要落到库上：前端的回合折叠本来只能
/// 按消息形态推断「回合结束」（末条纯文本 assistant = 答案），于是**被打断的
/// 回合**也会被当成正常结束收起来 —— 用户停止 / LLM 出错 / 应用崩溃后，
/// 过程被收走，重载后连错误提示都一起消失。现在折叠前先看这里：只有
/// `Completed` 才收。
///
/// `Running` 是**回合开始时的写入**（见 `ConversationPersister::begin_turn`）：
/// 进程若在收尾写入之前死掉（崩溃 / 强杀 / 断电），行上就留在 `Running` ——
/// 崩溃没有机会自己来写「我崩了」。下一次在该会话开启新回合时它被收敛成
/// `Interrupted`（见 `ConversationDb::begin_turn_state`），语义才归位。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnState {
    /// 回合进行中（也可能是上次进程没来得及收尾 —— 下次开新回合时收敛）。
    Running,
    /// 模型自然结束（agent loop 走到 Done）。
    Completed,
    /// 用户手动停止。
    Cancelled,
    /// 失败：LLM 报错 / 达到最大轮数 / 任务 panic。
    Failed,
    /// 上次运行期间进程消失（崩溃 / 强杀），没有任何收尾写入。
    Interrupted,
}

impl TurnState {
    /// 落库字符串（`messages.turn_state`）。前端按同一套字符串匹配，所以
    /// 与 serde 的一致性由 `tests::turn_state_str_matches_serde` 盯着。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
        }
    }

    /// 从库里的字符串读回来。
    ///
    /// **不认识的字符串 → `None`**：旧库没有这一列、将来新增变体（降级运行）
    /// 都可能读到别的值。绝不能把「不认识的收尾状态」当成正常结束，但也
    /// 不能炸 —— 回落成「没有记录」，由前端按消息形态判定（改动前的行为）。
    pub fn from_db_str(raw: &str) -> Option<Self> {
        match raw {
            "running" => Some(Self::Running),
            "completed" => Some(Self::Completed),
            "cancelled" => Some(Self::Cancelled),
            "failed" => Some(Self::Failed),
            "interrupted" => Some(Self::Interrupted),
            _ => None,
        }
    }

    /// 任务终态 → 回合收尾状态。
    ///
    /// 走的是任务**收尾后的真实状态**（`AgentTask::transition_to` 里
    /// `Cancelled` 是吸收态：停止命令先置 `Cancelled`、agent loop 退出时的
    /// 收尾写入不能把它改回已完成/失败，所以「被停止」必须问状态而不是问
    /// 返回值）。
    ///
    /// `match` 不写 `_ =>`：`AgentStatus` 加状态位时这里必须回答新状态属于
    /// 哪一种收尾。非终态映射到 `Running` 是**保守兜底**（本函数只在收尾
    /// 调用，走到那里状态必然已终态；真出现非终态就是没走终态写入 ——
    /// 前端不折叠，比误收起来强）。
    pub fn from_status(status: &AgentStatus) -> Self {
        match status {
            AgentStatus::Completed => Self::Completed,
            AgentStatus::Cancelled => Self::Cancelled,
            AgentStatus::Failed => Self::Failed,
            AgentStatus::Planning | AgentStatus::Executing | AgentStatus::WaitingApproval => {
                Self::Running
            }
        }
    }
}

/// Status of an individual item in the agent task plan.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PlanItemStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    Skipped,
}

/// A single step in the agent task plan.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub id: String,
    pub title: String,
    pub status: PlanItemStatus,
    pub error: Option<String>,
}

/// The agent task plan — a sequence of steps to fulfill a user request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskPlan {
    pub task_id: String,
    pub items: Vec<PlanItem>,
    pub current_index: usize,
    /// 下一个新增 item 的序号，用于生成 `item-{seq}` id。
    /// 删除 item 时不复用旧 id，避免 id 漂移导致 LLM 混淆。
    pub next_item_seq: usize,
    /// 反思提醒是否已触发过一次。
    /// 第一次把所有 item 标记为终态时，会回滚状态并提醒 LLM 反思。
    /// LLM 再次调用 update_plan_item 把最后一个 item 标记为终态时，不再拦截。
    pub reflection_reminded: bool,
}

/// Represents a single agent task — one user intent being fulfilled.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTask {
    pub id: String,
    pub session_id: String,
    pub conversation_id: String,
    pub prompt: String,
    pub mode: AgentMode,
    pub status: AgentStatus,
    pub has_plan: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// 父任务 id：subagent 工具派发的子agent（强制 Plan 模式调研）持有。
    /// 主任务为 None。用于级联取消与嵌套防御。
    #[serde(default)]
    pub parent_task_id: Option<String>,
    /// 本任务实际使用的模型（llmRegistry 模型条目 id）。
    /// 主任务来自会话级选择/全局默认解析；子 agent 继承父任务的该值，
    /// 保证「父用 A 模型 → 派发的子 agent 默认也用 A」。
    #[serde(default)]
    pub model_id: Option<String>,
    /// 本任务所属回合的锚点：回合首条 user 消息的 `messages` 行 id
    /// （agent loop 开头 `ConversationPersister::begin_turn` 回填该行的
    /// `turn_state = running`）。收尾时按它写入终态 —— 崩溃则留在 running。
    /// `None` = 没有可锚定的 user 消息行（空 prompt 等），本回合不记录收尾状态。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_anchor_id: Option<String>,
    /// 仅子任务：派发那一刻父会话**最后一条已落库消息**的 id —— 子代理回读主 agent
    /// 历史的**上界**（"派发那一刻之前"）。
    ///
    /// 下界不在这里冻结：读时取父会话"当前"最新压缩卡（见 `HistoryWindow`）。
    /// 于是父会话之后再压缩只会让子代理的窗口变小 —— 那仍然只含主 agent 当前
    /// 上下文里有的部分，且永远不会漏进归档原文，也不会因旧卡被吸收而锚点失效。
    ///
    /// `None` = 不是子任务，或派发时没能记下（此时回读父会话历史一律明确报错，
    /// 绝不当成"不限上界"）。主任务恒为 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_history_upto: Option<String>,
}

impl AgentTask {
    /// 写入状态，但 **`Cancelled` 是吸收态**：已取消的任务不接受任何后续写入。
    ///
    /// 为什么必须吸收：停止命令先把任务置 `Cancelled`（前端立刻显示「已停止」），
    /// 而 agent loop 要等当下的 LLM 调用 / 工具执行告一段落才退出，退出时才走到
    /// 收尾写入。无条件覆盖的话，用户会看到卡片从「已停止」跳回「已完成/失败」。
    ///
    /// 这条规则此前抄在两处（`manager::finalize_task` 与
    /// `tool_dispatcher::set_task_status`），加一个终态就要同步找齐。
    /// 返回是否真的写入了。
    pub fn transition_to(&mut self, status: AgentStatus) -> bool {
        if self.status.is_cancelled() {
            return false;
        }
        self.status = status;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_task(status: AgentStatus) -> AgentTask {
        AgentTask {
            id: "t1".into(),
            session_id: "s1".into(),
            conversation_id: "c1".into(),
            prompt: "p".into(),
            mode: AgentMode::Agent,
            status,
            has_plan: false,
            created_at: chrono::Utc::now(),
            parent_task_id: None,
            model_id: None,
            turn_anchor_id: None,
            parent_history_upto: None,
        }
    }

    /// 分类必须与这里的意图一致。
    ///
    /// 穷尽性由 `AgentStatus::is_running()` 的 `match` 在**编译期**保证（新增状态
    /// 位会让那里编译失败）。这条测试补的是另一半：分类改了、但「哪些状态算运行中」
    /// 这层意图没跟着改 这种漂移 —— 例如把 `WaitingApproval` 挪到终态却没人察觉。
    #[test]
    fn predicates_follow_the_intended_classification() {
        let cases = [
            (AgentStatus::Planning, true),
            (AgentStatus::Executing, true),
            (AgentStatus::WaitingApproval, true),
            (AgentStatus::Completed, false),
            (AgentStatus::Failed, false),
            (AgentStatus::Cancelled, false),
        ];
        for (status, running) in cases {
            assert_eq!(status.is_running(), running, "{:?} 的运行态判定不符", status);
            assert_eq!(status.is_terminal(), !running, "{:?} 的终态判定不符", status);
        }
    }

    /// 「终态」与「被取消」是两回事 —— 混用会让用户中止失败的任务被显示成「已停止」。
    #[test]
    fn is_cancelled_is_not_is_terminal() {
        assert!(AgentStatus::Cancelled.is_cancelled());
        assert!(AgentStatus::Cancelled.is_terminal());

        assert!(AgentStatus::Failed.is_terminal());
        assert!(!AgentStatus::Failed.is_cancelled(), "失败不是取消");
        assert!(AgentStatus::Completed.is_terminal());
        assert!(!AgentStatus::Completed.is_cancelled());

        assert!(!AgentStatus::Executing.is_cancelled());
        assert!(!AgentStatus::Executing.is_terminal());
    }

    /// `Cancelled` 吸收一切后续写入：停止命令先置 `Cancelled`，agent loop 退出时
    /// 的收尾写入不能把它改回「已完成/失败」。
    #[test]
    fn cancelled_absorbs_every_later_write() {
        let mut task = make_task(AgentStatus::Cancelled);
        assert!(
            !task.transition_to(AgentStatus::Completed),
            "已完成不该覆盖取消"
        );
        assert_eq!(task.status, AgentStatus::Cancelled);
        assert!(!task.transition_to(AgentStatus::Executing));
        assert_eq!(task.status, AgentStatus::Cancelled);
        assert!(!task.transition_to(AgentStatus::Failed));
        assert_eq!(task.status, AgentStatus::Cancelled);
    }

    /// 未被取消时照常写入（含「已终态再写」——旧实现也只保护 `Cancelled`，
    /// 这条把既有语义钉住，免得顺手"加强"成"终态一律吸收"）。
    #[test]
    fn transitions_are_written_when_not_cancelled() {
        let mut task = make_task(AgentStatus::Planning);
        assert!(task.transition_to(AgentStatus::WaitingApproval));
        assert_eq!(task.status, AgentStatus::WaitingApproval);
        assert!(task.transition_to(AgentStatus::Executing));
        assert_eq!(task.status, AgentStatus::Executing);
        assert!(task.transition_to(AgentStatus::Failed));
        assert_eq!(task.status, AgentStatus::Failed);
        // 已 Failed 再写 Completed 仍会写入（与旧行为一致）
        assert!(task.transition_to(AgentStatus::Completed));
        assert_eq!(task.status, AgentStatus::Completed);
    }

    /// `as_str()` 与 serde 序列化必须给出同一套字符串 —— 前者落库，分叉了就是
    /// 「库里写 cancelled、别处读 Cancelled」。
    #[test]
    fn turn_state_str_matches_serde() {
        let cases = [
            (TurnState::Running, "running"),
            (TurnState::Completed, "completed"),
            (TurnState::Cancelled, "cancelled"),
            (TurnState::Failed, "failed"),
            (TurnState::Interrupted, "interrupted"),
        ];
        for (state, expected) in cases {
            assert_eq!(state.as_str(), expected);
            assert_eq!(
                serde_json::to_string(&state).unwrap(),
                format!("\"{expected}\"")
            );
            // 落库 → 读回是同一条（库里只有小写这一种写法）
            assert_eq!(TurnState::from_db_str(expected), Some(state));
        }
        // 旧库的值（NULL 走 Option）与未知串 → None：不炸、也不冒充正常结束
        assert_eq!(TurnState::from_db_str(""), None);
        assert_eq!(TurnState::from_db_str("Completed"), None);
        assert_eq!(TurnState::from_db_str("whatever"), None);
    }

    /// 任务终态 → 回合收尾状态：每个变体都要有明确归属（`from_status` 的
    /// `match` 不写 `_ =>`，新增状态位编译不过；这条补的是「归属写错了」）。
    #[test]
    fn turn_state_from_status_classifies_every_status() {
        let cases = [
            (AgentStatus::Completed, TurnState::Completed),
            (AgentStatus::Cancelled, TurnState::Cancelled),
            (AgentStatus::Failed, TurnState::Failed),
            // 非终态不可达（只在收尾调用）→ 保守映射成 Running = 前端不折叠
            (AgentStatus::Planning, TurnState::Running),
            (AgentStatus::Executing, TurnState::Running),
            (AgentStatus::WaitingApproval, TurnState::Running),
        ];
        for (status, expected) in &cases {
            assert_eq!(TurnState::from_status(status), *expected, "{status:?}");
        }
        // 只有 Completed 算正常结束 —— 「谁能折叠」钉死在代码旁边
        let foldable: Vec<AgentStatus> = cases
            .iter()
            .filter(|(_, s)| *s == TurnState::Completed)
            .map(|(status, _)| status.clone())
            .collect();
        assert_eq!(foldable, vec![AgentStatus::Completed]);
    }
}
