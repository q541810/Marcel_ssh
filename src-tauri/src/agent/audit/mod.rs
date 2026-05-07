mod writer;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::agent::sandbox::RiskLevel;

const FIELD_MAX_BYTES: usize = 1024;
const TRUNC_SUFFIX: &str = "…[truncated]";

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

/// Outcome of an audited operation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum Outcome {
    Success,
    Fail,
    Blocked,
    Approved,
    Denied,
}

/// User decision on an approval request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum UserDecision {
    Auto,
    Approved,
    Rejected,
    Timeout,
    NotApplicable,
}

/// A single entry in the audit log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: String,
    pub task_id: String,
    pub timestamp: DateTime<Utc>,
    pub action: AuditAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Deprecated: legacy free-form result. Prefer `result_summary` / `error`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk_level: Option<RiskLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Outcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_decision: Option<UserDecision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn truncate_field(s: String) -> String {
    if s.len() <= FIELD_MAX_BYTES {
        return s;
    }
    // Cut on a UTF-8 char boundary <= FIELD_MAX_BYTES.
    let mut cut = FIELD_MAX_BYTES;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    let mut out = String::with_capacity(cut + TRUNC_SUFFIX.len());
    out.push_str(&s[..cut]);
    out.push_str(TRUNC_SUFFIX);
    out
}

fn sanitize_entry(mut entry: AuditEntry) -> AuditEntry {
    if let Some(c) = entry.command.take() {
        entry.command = Some(truncate_field(c));
    }
    if let Some(c) = entry.result_summary.take() {
        entry.result_summary = Some(truncate_field(c));
    }
    if let Some(c) = entry.error.take() {
        entry.error = Some(truncate_field(c));
    }
    entry
}

/// Append-only audit log for agent operations.
///
/// Maintains an in-memory ring buffer of recent entries plus an optional
/// JSONL on-disk writer for persistence.
pub struct AuditLog {
    recent: VecDeque<AuditEntry>,
    capacity: usize,
    writer: Option<Arc<writer::JsonlWriter>>,
}

impl std::fmt::Debug for AuditLog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuditLog")
            .field("recent_len", &self.recent.len())
            .field("capacity", &self.capacity)
            .field("persistent", &self.writer.is_some())
            .finish()
    }
}

impl AuditLog {
    /// Create an in-memory only audit log with default capacity (1000).
    pub fn new() -> Self {
        Self {
            recent: VecDeque::new(),
            capacity: 1000,
            writer: None,
        }
    }

    /// Create an audit log backed by a JSONL writer rooted at `dir`.
    pub async fn with_dir(dir: PathBuf, capacity: usize) -> std::io::Result<Self> {
        let writer = writer::JsonlWriter::open(dir).await?;
        Ok(Self {
            recent: VecDeque::new(),
            capacity: capacity.max(1),
            writer: Some(Arc::new(writer)),
        })
    }

    fn push_recent(&mut self, entry: AuditEntry) {
        if self.recent.len() >= self.capacity {
            self.recent.pop_front();
        }
        self.recent.push_back(entry);
    }

    /// Record a new audit entry (in-memory only). Backwards-compatible API.
    pub fn record(&mut self, entry: AuditEntry) {
        self.push_recent(sanitize_entry(entry));
    }

    /// Record a new audit entry into memory and persist it to disk.
    /// Persistence errors are logged but never propagated.
    pub async fn record_persistent(&mut self, entry: AuditEntry) {
        let entry = sanitize_entry(entry);
        if let Some(w) = self.writer.clone() {
            if let Err(e) = w.append(&entry).await {
                log::error!("audit log persist failed: {e}");
            }
        }
        self.push_recent(entry);
    }

    /// Get all entries for a specific task (in-memory).
    pub fn get_entries_for_task(&self, task_id: &str) -> Vec<&AuditEntry> {
        self.recent.iter().filter(|e| e.task_id == task_id).collect()
    }

    /// Query in-memory entries by task id (owned clones).
    pub fn query_by_task(&self, task_id: &str) -> Vec<AuditEntry> {
        self.recent
            .iter()
            .filter(|e| e.task_id == task_id)
            .cloned()
            .collect()
    }

    /// Query in-memory entries by [from, to] timestamp window (inclusive).
    pub fn query_by_time(
        &self,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
    ) -> Vec<AuditEntry> {
        self.recent
            .iter()
            .filter(|e| e.timestamp >= from && e.timestamp <= to)
            .cloned()
            .collect()
    }

    /// Read the last `n` valid entries from today's on-disk file.
    /// Corrupted (non-JSON) lines are skipped.
    pub async fn tail_today(&self, n: usize) -> std::io::Result<Vec<AuditEntry>> {
        let writer = match &self.writer {
            Some(w) => w.clone(),
            None => return Ok(Vec::new()),
        };
        let path = writer.current_path().await;
        if !fs::try_exists(&path).await.unwrap_or(false) {
            return Ok(Vec::new());
        }
        let file = fs::File::open(&path).await?;
        let mut reader = BufReader::new(file).lines();
        let mut all: Vec<AuditEntry> = Vec::new();
        while let Some(line) = reader.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<AuditEntry>(&line) {
                Ok(e) => all.push(e),
                Err(err) => {
                    log::warn!("audit log: skipping corrupted line: {err}");
                }
            }
        }
        if all.len() > n {
            let start = all.len() - n;
            all.drain(..start);
        }
        Ok(all)
    }

    /// Total number of in-memory entries.
    pub fn len(&self) -> usize {
        self.recent.len()
    }

    /// Whether the in-memory log is empty.
    pub fn is_empty(&self) -> bool {
        self.recent.is_empty()
    }
}

impl Default for AuditLog {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;
    use tempfile::TempDir;
    use tokio::io::AsyncWriteExt;

    fn mk_entry(task_id: &str, command: Option<&str>) -> AuditEntry {
        AuditEntry {
            id: uuid::Uuid::new_v4().to_string(),
            task_id: task_id.to_string(),
            timestamp: Utc::now(),
            action: AuditAction::CommandExecuted,
            command: command.map(|s| s.to_string()),
            result: None,
            risk_level: None,
            session_id: None,
            tool_name: None,
            outcome: Some(Outcome::Success),
            user_decision: Some(UserDecision::Auto),
            duration_ms: Some(1),
            result_summary: None,
            error: None,
        }
    }

    #[tokio::test]
    async fn write_and_tail_preserves_order() {
        let dir = TempDir::new().unwrap();
        let mut log = AuditLog::with_dir(dir.path().to_path_buf(), 100).await.unwrap();
        for i in 0..5 {
            log.record_persistent(mk_entry("t1", Some(&format!("cmd-{i}")))).await;
        }
        let tail = log.tail_today(10).await.unwrap();
        assert_eq!(tail.len(), 5);
        for (i, e) in tail.iter().enumerate() {
            assert_eq!(e.command.as_deref(), Some(format!("cmd-{i}").as_str()));
        }
    }

    #[tokio::test]
    async fn persists_across_reopen() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();
        {
            let mut log = AuditLog::with_dir(path.clone(), 100).await.unwrap();
            log.record_persistent(mk_entry("t-x", Some("hello"))).await;
        }
        let log2 = AuditLog::with_dir(path, 100).await.unwrap();
        let tail = log2.tail_today(10).await.unwrap();
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].task_id, "t-x");
    }

    #[tokio::test]
    async fn rolls_over_at_date_boundary() {
        let dir = TempDir::new().unwrap();
        let mut log = AuditLog::with_dir(dir.path().to_path_buf(), 100).await.unwrap();
        let yesterday = Utc::now().date_naive() - Duration::days(1);
        log.writer
            .as_ref()
            .unwrap()
            .set_date_for_test(yesterday)
            .await
            .unwrap();
        log.record_persistent(mk_entry("t-old", Some("yest"))).await;
        let yesterday_path = dir.path().join(format!(
            "agent-audit-{}.jsonl",
            yesterday.format("%Y%m%d")
        ));
        assert!(yesterday_path.exists(), "yesterday file must exist");

        log.record_persistent(mk_entry("t-new", Some("today"))).await;
        let today = Utc::now().date_naive();
        let today_path = dir
            .path()
            .join(format!("agent-audit-{}.jsonl", today.format("%Y%m%d")));
        assert!(today_path.exists(), "today file must be created");
        // tail_today should only return today's entries.
        let tail = log.tail_today(10).await.unwrap();
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].task_id, "t-new");
    }

    #[tokio::test]
    async fn tolerates_corrupted_lines() {
        let dir = TempDir::new().unwrap();
        let mut log = AuditLog::with_dir(dir.path().to_path_buf(), 100).await.unwrap();
        let path = log.writer.as_ref().unwrap().current_path().await;
        // append a garbage line directly
        {
            let mut f = tokio::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .await
                .unwrap();
            f.write_all(b"not-a-json\n").await.unwrap();
            f.flush().await.unwrap();
        }
        log.record_persistent(mk_entry("t-ok", Some("good"))).await;
        let tail = log.tail_today(10).await.unwrap();
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].command.as_deref(), Some("good"));
    }

    #[tokio::test]
    async fn truncates_oversized_fields() {
        let dir = TempDir::new().unwrap();
        let mut log = AuditLog::with_dir(dir.path().to_path_buf(), 100).await.unwrap();
        let big = "a".repeat(4096);
        log.record_persistent(mk_entry("t", Some(&big))).await;
        let tail = log.tail_today(10).await.unwrap();
        let cmd = tail[0].command.as_ref().unwrap();
        assert!(cmd.ends_with(TRUNC_SUFFIX), "expected truncation suffix");
        assert!(cmd.len() <= FIELD_MAX_BYTES + TRUNC_SUFFIX.len());
    }

    #[tokio::test]
    async fn query_by_task_matches_tail() {
        let dir = TempDir::new().unwrap();
        let mut log = AuditLog::with_dir(dir.path().to_path_buf(), 1000).await.unwrap();
        for i in 0..30 {
            let tid = if i % 3 == 0 { "alpha" } else { "beta" };
            log.record_persistent(mk_entry(tid, Some(&format!("c{i}")))).await;
        }
        let mem = log.query_by_task("alpha");
        let tail = log.tail_today(1000).await.unwrap();
        let from_tail: Vec<_> = tail.into_iter().filter(|e| e.task_id == "alpha").collect();
        assert_eq!(mem.len(), from_tail.len());
        assert!(!mem.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_file_mode_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let mut log = AuditLog::with_dir(dir.path().to_path_buf(), 10).await.unwrap();
        log.record_persistent(mk_entry("t", Some("x"))).await;
        let path = log.writer.as_ref().unwrap().current_path().await;
        let meta = std::fs::metadata(&path).unwrap();
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0600, got {mode:o}");
    }

    #[tokio::test]
    async fn concurrent_record_persistent() {
        use std::sync::Arc as StdArc;
        use tokio::sync::Mutex as TokioMutex;

        let dir = TempDir::new().unwrap();
        let log = StdArc::new(TokioMutex::new(
            AuditLog::with_dir(dir.path().to_path_buf(), 1000).await.unwrap(),
        ));
        let mut handles = Vec::new();
        for i in 0..100 {
            let log = log.clone();
            handles.push(tokio::spawn(async move {
                let entry = mk_entry("t-c", Some(&format!("c{i}")));
                log.lock().await.record_persistent(entry).await;
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        let guard = log.lock().await;
        let path = guard.writer.as_ref().unwrap().current_path().await;
        drop(guard);
        let content = tokio::fs::read_to_string(&path).await.unwrap();
        let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), 100);
        for l in lines {
            serde_json::from_str::<AuditEntry>(l).expect("each line must parse");
        }
    }
}
