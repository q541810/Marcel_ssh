use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::agent::sandbox::RiskLevel;

/// Types of actions recorded in the audit log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AuditAction {
    TaskStarted,
    TaskCompleted,
    TaskFailed,
    CommandExecuted,
    CommandBlocked,
    ApprovalRequested,
    ApprovalGranted,
    ApprovalDenied,
}

/// A single entry in the audit log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: String,
    pub task_id: String,
    pub timestamp: DateTime<Utc>,
    pub action: AuditAction,
    pub command: Option<String>,
    pub result: Option<String>,
    pub risk_level: Option<RiskLevel>,
}

/// Append-only audit log for agent operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditLog {
    entries: Vec<AuditEntry>,
}

impl AuditLog {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    /// Record a new audit entry.
    pub fn record(&mut self, entry: AuditEntry) {
        self.entries.push(entry);
    }

    /// Get all entries for a specific task.
    pub fn get_entries_for_task(&self, task_id: &str) -> Vec<&AuditEntry> {
        self.entries
            .iter()
            .filter(|e| e.task_id == task_id)
            .collect()
    }

    /// Get total number of entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Check if the log is empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl Default for AuditLog {
    fn default() -> Self {
        Self::new()
    }
}
