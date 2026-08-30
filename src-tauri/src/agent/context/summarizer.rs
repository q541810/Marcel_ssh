//! LLM 摘要（对齐 DSH `compaction-basic/summarizer.ts`）：
//! 重放被压区间的原始消息 + 摘要指令（作为最后一条 user 消息），非流式一次直调。
//! 输出经 `<compacted-summary>` 标签 framing，由调用方做 shrink 校验。

use std::sync::Mutex;

use crate::llm::manager::LlmManager;
use crate::llm::openai::TextSink;
use crate::llm::provider::LlmMessage;

/// 摘要输出 framing 标签。
pub const SUMMARY_OPEN_TAG: &str = "<compacted-summary>";
pub const SUMMARY_CLOSE_TAG: &str = "</compacted-summary>";

/// 替换节点前置说明（照搬 DSH）：让模型把摘要视为既有背景，不再复述。
pub const CHECKPOINT_PREAMBLE: &str = "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";

/// 摘要指令（照搬 DSH 八段结构 + 保真规则 + 旧摘要合并规则）。
pub const COMPACTION_INSTRUCTION: &str = "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.

Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write \"(none)\" for an empty section — never drop a section.

## Primary Request and Intent
- [the user's original and evolving goals; quote verbatim where the exact wording matters]

## Key Technical Concepts
- [technologies, frameworks, patterns, and conventions in play]

## Files and Code
- [exact path: why it matters, key changes or snippets]

## Errors and Fixes
- [error: how it was resolved, plus any related user feedback]

## Pending Jobs
- [explicitly requested work not yet completed]

## Current Work
- [precisely what was in progress at this checkpoint]

## Next Step
- [the single next action, directly in line with the most recent request, or \"(none)\"]

## Critical Context
- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]

Rules:
- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.
- Capture user feedback and explicit instructions faithfully, especially corrections.
- Do NOT mention this summarization request or that the context was compacted.
- Output only the checkpoint text: do not call any tool or take any other action.
- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.";

/// 摘要调用的输入：会话自己的 system（若有）+ 被压区间原始消息。
/// 注意：**不传工具 schema**——模型看到工具列表会倾向于模仿历史里的
/// 工具调用模式，导致摘要调用输出 tool_calls 而非 checkpoint（实测发生）。
/// 不传工具后模型无从调用，只能输出文本。
pub struct SummarizationInput<'a> {
    /// 会话 system 提示词（msl 下恒为 `None`：中文人格设定会带偏摘要模型，
    /// 见 `compact_region` 的说明）。
    pub system: Option<&'a str>,
    /// 被压区间消息（原始内容，surface 顺序）。
    pub region: &'a [LlmMessage],
}

/// 摘要输出上限（对齐 DSH `maxTokens` 默认 8192）：显式 cap + 截断拒绝，
/// 避免摘要失控或依赖 provider 默认值。
pub const SUMMARY_MAX_TOKENS: u32 = 8192;

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

/// 非流式一次直调摘要（可选流式进度）。返回裸摘要文本（不含 framing）。
///
/// `progress` 存在时走流式路径：每个文本增量累积后以完整文本实时回调
/// （`progress("当前已生成的摘要全文")`），重试时自动清空累积、从头再来，
/// 保证回调文本始终是"当前尝试"的完整进度。摘要完成后返回全文。
///
/// 失败（provider 错误 / 空输出 / max_tokens 截断）返回 `Err`；
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
    messages.push(LlmMessage::user(COMPACTION_INSTRUCTION));

    let resp = match progress {
        Some(progress) => {
            // 累积缓冲：delta 追加，reset 清空（重试发起新一轮流之前由 sink 调用）
            let acc: Mutex<String> = Mutex::new(String::new());
            let reset = || {
                acc.lock().unwrap().clear();
            };
            let delta = |text: &str| {
                let mut buf = acc.lock().unwrap();
                buf.push_str(text);
                let snapshot = buf.clone();
                drop(buf);
                progress(snapshot.as_str());
            };
            let sink = TextSink {
                reset: &reset,
                delta: &delta,
            };
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            // 事件通道只作内部转发，丢弃（摘要进度走 sink 回调）
            tokio::spawn(async move { while rx.recv().await.is_some() {} });
            // 不传工具 schema（见 SummarizationInput 注释）：模型无从调用工具。
            // 显式 max_tokens（对齐 DSH 8192）：截断靠 finish_reason 拒绝。
            manager
                .stream_chat_with_sink(
                    &messages,
                    &[],
                    &tx,
                    Some(sink),
                    Some(SUMMARY_MAX_TOKENS),
                    None,
                )
                .await
                .map_err(|e| format!("摘要生成失败：{}", e))?
        }
        None => manager
            .send_message(&messages, &[], None)
            .await
            .map_err(|e| format!("摘要生成失败：{}", e))?,
    };

    if is_summary_truncated(resp.finish_reason.as_deref()) {
        return Err("摘要被输出长度上限截断（生成不完整），已放弃本次压缩".into());
    }
    // 模型试图调用工具 = 没按"只输出 checkpoint"指令走，拒绝
    if resp.tool_calls.is_some() {
        return Err("模型未按指令输出（试图调用工具），已放弃本次压缩".into());
    }

    let text = resp.content.trim().to_string();
    if text.is_empty() {
        return Err("摘要生成未产出内容，已放弃本次压缩".into());
    }
    // 八段结构校验：模型跑偏（打招呼/闲聊）时没有任何章节标题，直接拒绝
    if !has_required_sections(&text) {
        return Err("模型未按指令输出结构化摘要（缺少八段章节），已放弃本次压缩".into());
    }
    Ok(text)
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
                COMPACTION_INSTRUCTION.contains(section),
                "missing {section}"
            );
        }
    }

    #[test]
    fn instruction_contains_prior_checkpoint_merge_rule() {
        assert!(COMPACTION_INSTRUCTION.contains("PRIOR checkpoint"));
    }

    #[test]
    fn instruction_forbids_tool_calls() {
        assert!(COMPACTION_INSTRUCTION.contains("do not call any tool"));
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
}
