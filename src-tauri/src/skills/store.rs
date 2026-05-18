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

    /// Return the concatenated prompts of all enabled skills.
    /// Each prompt is wrapped in a section header so the LLM can distinguish them.
    pub fn enabled_prompts(&self) -> String {
        self.skills
            .iter()
            .filter(|s| s.enabled)
            .map(|s| {
                format!(
                    "[Skill: {}]\n{}\n",
                    s.name, s.prompt
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

impl JsonPersistable for SkillStore {
    fn default_filename() -> &'static str {
        "skills.json"
    }
}
