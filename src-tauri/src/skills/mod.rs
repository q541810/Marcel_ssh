/// Skills 系统 — 用户自定义的 AI 行为指令。
///
/// 每个 Skill 是一段追加到 Agent system prompt 的自定义文本。
/// 用户可在「Skill」面板中创建、编辑、启用/禁用 skill。
/// 已启用的 skill 会在每次 Agent 任务启动时自动注入到对话上下文。
pub mod builtin;
pub mod parser;
pub mod store;

pub use store::{Skill, SkillStore};
