use chrono::Utc;

use crate::skills::parser::process_md;
use crate::skills::store::{Skill, SkillStore};

/// 内置 skill 的 id 前缀。前后端都以此前缀识别内置 skill。
///
/// 设计约定（不可破坏）：
/// - 内置 skill 使用**固定确定性 id**，保证多设备同步后仍是同一条记录；
/// - 内置 skill **不可编辑、不可删除**，只能启用/禁用——内容始终以当前
///   二进制内嵌的版本为准，应用升级后启动时无条件覆盖，确保用户总能
///   吃到最新教学内容（enabled 状态保留）；
/// - `skill_update` / `skill_delete` command 与 sync 的 `apply_skill`
///   都必须遵守上述规则（见 `commands/skill.rs`、`sync/accessor.rs`）。
pub const BUILTIN_SKILL_PREFIX: &str = "builtin.";

pub fn is_builtin_skill_id(id: &str) -> bool {
    id.starts_with(BUILTIN_SKILL_PREFIX)
}

struct BuiltinSkillDef {
    id: &'static str,
    /// SKILL.md 内容（含 YAML frontmatter），编译期嵌入二进制。
    content: &'static str,
}

const BUILTIN_SKILLS: &[BuiltinSkillDef] = &[
    BuiltinSkillDef {
        id: "builtin.agent-modes",
        content: include_str!("../../builtin_skills/agent-modes.md"),
    },
    BuiltinSkillDef {
        id: "builtin.model-setup",
        content: include_str!("../../builtin_skills/model-setup.md"),
    },
    BuiltinSkillDef {
        id: "builtin.extensions",
        content: include_str!("../../builtin_skills/extensions.md"),
    },
    BuiltinSkillDef {
        id: "builtin.visualize",
        content: include_str!("../../builtin_skills/visualize.md"),
    },
];

/// 启动时调用：把内置 skill 注入/更新到 store。
///
/// - 本地不存在 → 注入（enabled = true）；
/// - 本地存在但内容与二进制内嵌版本不同（旧版本内容、或旧版本 App 允许
///   编辑时被用户改过）→ 覆盖为内嵌版本，**保留 enabled 与 created_at**；
/// - 内容一致 → 不动（不产生变更、不触发同步）。
///
/// 返回发生注入/更新的 skill 列表，调用方据此决定是否持久化 + 推送同步。
pub fn ensure_builtin_skills(store: &mut SkillStore) -> Vec<Skill> {
    let mut changed = Vec::new();
    for def in BUILTIN_SKILLS {
        let parsed = match process_md(def.content, def.id) {
            Ok(p) => p,
            Err(e) => {
                // 内容编译期嵌入，解析失败属于打包错误；有单测保证，这里仅防御。
                log::error!("内置 skill {} 解析失败: {}", def.id, e);
                continue;
            }
        };
        let now = Utc::now().to_rfc3339();
        match store.skills.iter_mut().find(|s| s.id == def.id) {
            Some(existing) => {
                if existing.name != parsed.name
                    || existing.description != parsed.description
                    || existing.prompt != parsed.prompt
                {
                    existing.name = parsed.name;
                    existing.description = parsed.description;
                    existing.prompt = parsed.prompt;
                    existing.updated_at = now;
                    changed.push(existing.clone());
                }
            }
            None => {
                let skill = Skill {
                    id: def.id.to_string(),
                    name: parsed.name,
                    description: parsed.description,
                    prompt: parsed.prompt,
                    enabled: true,
                    // 内置 skill 置顶由前端展示层保证，position 不参与排序
                    position: 0.0,
                    created_at: now.clone(),
                    updated_at: now,
                };
                store.skills.push(skill.clone());
                changed.push(skill);
            }
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_defs_parse_and_ids_are_valid() {
        let mut ids = std::collections::HashSet::new();
        for def in BUILTIN_SKILLS {
            assert!(
                is_builtin_skill_id(def.id),
                "内置 skill id 必须以 {} 开头: {}",
                BUILTIN_SKILL_PREFIX,
                def.id
            );
            assert!(ids.insert(def.id), "内置 skill id 重复: {}", def.id);
            let parsed = process_md(def.content, def.id)
                .unwrap_or_else(|e| panic!("内置 skill {} 解析失败: {}", def.id, e));
            assert!(!parsed.name.trim().is_empty(), "{} name 为空", def.id);
            assert!(
                !parsed.description.trim().is_empty(),
                "{} description 为空（LLM 靠它决定何时调用）",
                def.id
            );
            assert!(!parsed.prompt.trim().is_empty(), "{} prompt 为空", def.id);
        }
    }

    #[test]
    fn visualize_skill_keeps_full_authoring_contract_and_examples() {
        let def = BUILTIN_SKILLS
            .iter()
            .find(|def| def.id == "builtin.visualize")
            .expect("builtin.visualize must be registered");
        let parsed = process_md(def.content, def.id).expect("visualize skill must parse");
        for required in [
            "--viz-series-1",
            ".viz-controls",
            "chart.js@4.4.1",
            "new Chart(ctx",
            "chart.update()",
            "new ResizeObserver(draw)",
            "不要从零发明仪表盘布局",
            "动效是硬性验收项",
            "可中断性最重要",
            "function springTo(state, target, render)",
            "采用高召回策略",
            "不要先询问“要不要做图”",
            "项目没有 Mermaid 展示能力",
            "不提工具、fragment、文件或实现机制",
        ] {
            assert!(
                parsed.prompt.contains(required),
                "visualize skill 缺少关键契约/示例: {required}"
            );
        }
    }

    #[test]
    fn inject_into_empty_store() {
        let mut store = SkillStore::new();
        let changed = ensure_builtin_skills(&mut store);
        assert_eq!(changed.len(), BUILTIN_SKILLS.len());
        assert_eq!(store.skills.len(), BUILTIN_SKILLS.len());
        assert!(store.skills.iter().all(|s| s.enabled));
    }

    #[test]
    fn second_run_is_noop() {
        let mut store = SkillStore::new();
        ensure_builtin_skills(&mut store);
        let changed = ensure_builtin_skills(&mut store);
        assert!(changed.is_empty(), "内容一致时不应产生变更");
    }

    #[test]
    fn disabled_state_is_preserved() {
        let mut store = SkillStore::new();
        ensure_builtin_skills(&mut store);
        let id = BUILTIN_SKILLS[0].id;
        assert!(store.toggle(id));
        let changed = ensure_builtin_skills(&mut store);
        assert!(changed.is_empty());
        assert!(!store.get(id).unwrap().enabled, "禁用状态必须保留");
    }

    #[test]
    fn stale_content_is_overwritten_keeping_enabled_and_created_at() {
        let mut store = SkillStore::new();
        ensure_builtin_skills(&mut store);
        let id = BUILTIN_SKILLS[0].id;
        store.toggle(id); // 用户禁用
        let created_at = store.get(id).unwrap().created_at.clone();
        // 模拟旧版本内容 / 旧版本 App 中被编辑过
        {
            let s = store.skills.iter_mut().find(|s| s.id == id).unwrap();
            s.prompt = "旧版内容".into();
            s.name = "旧版名称".into();
        }
        let changed = ensure_builtin_skills(&mut store);
        assert_eq!(changed.len(), 1);
        let s = store.get(id).unwrap();
        assert_ne!(s.prompt, "旧版内容", "内容必须被覆盖为内嵌版本");
        assert!(!s.enabled, "覆盖内容时保留 enabled");
        assert_eq!(s.created_at, created_at, "覆盖内容时保留 created_at");
    }

    #[test]
    fn user_skills_are_untouched() {
        let mut store = SkillStore::new();
        store.add(Skill::new("我的 skill", "desc", "prompt"));
        let before = store.skills[0].clone();
        ensure_builtin_skills(&mut store);
        let after = store.get(&before.id).unwrap();
        assert_eq!(after.prompt, before.prompt);
        assert_eq!(after.updated_at, before.updated_at);
    }
}
