use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::config::persist::JsonPersistable;

fn default_true() -> bool {
    true
}

/// A user-defined AI behavior instruction.
/// When enabled, its prompt is appended to every Agent system prompt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub prompt: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 手动排序位置（用户拖拽排序）。仅对用户 skill 有意义；内置 skill
    /// 在 UI 中始终置顶，不参与排序。缺省 0.0：旧数据无此字段时全部并列，
    /// 前端稳定排序保持原有相对顺序（兼容 = 保持原样）。
    #[serde(default)]
    pub position: f64,
    pub created_at: String,
    pub updated_at: String,
}

impl Skill {
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        prompt: impl Into<String>,
    ) -> Self {
        let now = Utc::now().to_rfc3339();
        Self {
            id: Uuid::new_v4().to_string(),
            name: name.into(),
            description: description.into(),
            prompt: prompt.into(),
            enabled: true,
            position: 0.0,
            created_at: now.clone(),
            updated_at: now,
        }
    }
}

/// Persistent store for user skills.
/// Serialised to skills.json in the app config directory.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillStore {
    pub skills: Vec<Skill>,
}

impl SkillStore {
    pub fn new() -> Self {
        Self { skills: Vec::new() }
    }

    pub fn list(&self) -> &[Skill] {
        &self.skills
    }

    pub fn get(&self, id: &str) -> Option<&Skill> {
        self.skills.iter().find(|s| s.id == id)
    }

    pub fn add(&mut self, skill: Skill) {
        self.skills.push(skill);
    }

    pub fn update(
        &mut self,
        id: &str,
        name: Option<String>,
        description: Option<String>,
        prompt: Option<String>,
    ) -> bool {
        let now = Utc::now().to_rfc3339();
        if let Some(skill) = self.skills.iter_mut().find(|s| s.id == id) {
            if let Some(n) = name {
                skill.name = n;
            }
            if let Some(d) = description {
                skill.description = d;
            }
            if let Some(p) = prompt {
                skill.prompt = p;
            }
            skill.updated_at = now;
            return true;
        }
        false
    }

    pub fn toggle(&mut self, id: &str) -> bool {
        if let Some(skill) = self.skills.iter_mut().find(|s| s.id == id) {
            skill.enabled = !skill.enabled;
            skill.updated_at = Utc::now().to_rfc3339();
            return true;
        }
        false
    }

    pub fn delete(&mut self, id: &str) -> bool {
        let len_before = self.skills.len();
        self.skills.retain(|s| s.id != id);
        self.skills.len() != len_before
    }

    /// 下一个可用的手动排序位置（追加到列表末尾）。
    pub fn next_position(&self) -> f64 {
        self.skills
            .iter()
            .map(|s| s.position)
            .fold(0.0_f64, f64::max)
            + 1.0
    }

    /// 按给定 id 顺序重排用户 skill 的 position（index * 1000，留出后续
    /// 手动插入的间隙）。忽略不存在的 id；内置 skill 由调用方拒绝。
    ///
    /// 返回 position 发生变化的 skill 克隆，调用方据此持久化 + 推送同步。
    /// 不改动 updated_at：顺序是轻量视图元数据，不应制造内容变更的假象。
    pub fn apply_user_order(&mut self, ordered_ids: &[String]) -> Vec<Skill> {
        let mut changed = Vec::new();
        for (index, id) in ordered_ids.iter().enumerate() {
            let pos = (index + 1) as f64 * 1000.0;
            if let Some(skill) = self.skills.iter_mut().find(|s| &s.id == id) {
                if (skill.position - pos).abs() > f64::EPSILON {
                    skill.position = pos;
                    changed.push(skill.clone());
                }
            }
        }
        changed
    }

    /// Return the concatenated prompts of all enabled skills.
    /// Each prompt is wrapped in a section header so the LLM can distinguish them.
    pub fn enabled_prompts(&self) -> String {
        self.skills
            .iter()
            .filter(|s| s.enabled)
            .map(|s| format!("[Skill: {}]\n{}\n", s.name, s.prompt))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

impl JsonPersistable for SkillStore {
    fn default_filename() -> &'static str {
        "skills.json"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_data_without_position_defaults_to_zero() {
        let json = r#"{
            "id": "a", "name": "n", "prompt": "p",
            "enabled": true, "createdAt": "t", "updatedAt": "t"
        }"#;
        let skill: Skill = serde_json::from_str(json).unwrap();
        assert_eq!(skill.position, 0.0);
    }

    #[test]
    fn next_position_appends_after_max() {
        let mut store = SkillStore::new();
        assert_eq!(store.next_position(), 1.0);
        let mut a = Skill::new("a", "", "");
        a.position = 5.0;
        store.add(a);
        assert_eq!(store.next_position(), 6.0);
    }

    #[test]
    fn apply_user_order_assigns_positions_and_reports_changes() {
        let mut store = SkillStore::new();
        store.add(Skill::new("a", "", ""));
        store.add(Skill::new("b", "", ""));
        store.add(Skill::new("c", "", ""));
        let ids: Vec<String> = store.skills.iter().map(|s| s.id.clone()).collect();
        // 反转顺序：c, b, a
        let mut reversed = ids.clone();
        reversed.reverse();
        let changed = store.apply_user_order(&reversed);
        assert_eq!(changed.len(), 3);
        assert_eq!(store.get(&reversed[0]).unwrap().position, 1000.0);
        assert_eq!(store.get(&reversed[1]).unwrap().position, 2000.0);
        assert_eq!(store.get(&reversed[2]).unwrap().position, 3000.0);
        // 再跑一次相同顺序：无变化
        assert!(store.apply_user_order(&reversed).is_empty());
    }

    #[test]
    fn apply_user_order_ignores_unknown_ids_and_keeps_others() {
        let mut store = SkillStore::new();
        store.add(Skill::new("a", "", ""));
        let id_a = store.skills[0].id.clone();
        let changed = store.apply_user_order(&["missing".to_string(), id_a.clone()]);
        assert_eq!(changed.len(), 1);
        // "missing" 被忽略但占用了 index 0，a 拿到 index 1 的位置
        assert_eq!(store.get(&id_a).unwrap().position, 2000.0);
    }

    #[test]
    fn apply_user_order_partial_list_positions_by_given_index() {
        let mut store = SkillStore::new();
        store.add(Skill::new("a", "", ""));
        store.add(Skill::new("b", "", ""));
        let id_b = store.skills[1].id.clone();
        // 仅列出 b：b 拿到 index 0 的位置
        let changed = store.apply_user_order(&[id_b.clone()]);
        assert_eq!(changed.len(), 1);
        assert_eq!(store.get(&id_b).unwrap().position, 1000.0);
    }
}
