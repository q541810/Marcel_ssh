//! 后台作业（Background Job）—— [`crate::command_exec`] 体系的一部分。
//!
//! 后台作业不是一套平行的执行体系，而是「提交后立即返回、输出流式沉淀」的
//! 命令执行模式：执行仍走 [`super::manager::CommandExecutionManager`] 的
//! 统一注册表（exec_id、取消注册表、断连级联取消、审计记录全部复用），
//! 本模块只提供 Job 的**状态模型**与**输出沉淀**（环形缓冲 + 磁盘溢出文件）：
//!
//! - 内存中每作业保留最近 [`MAX_RING_BUFFER_BYTES`] 字节，完整输出写入
//!   临时目录的 `marcel-job-<id>.log`，`offset` 回读超出环形窗口时从
//!   溢出文件补齐。
//! - `notify` watch 通道在每有新输出或状态迁移时递增总字节数，
//!   `job_output(wait=true)` 据此非忙等唤醒。
//!
//! 安全约定：`JobInfo.command` 只存展示命令（截断），绝不存含 sudo
//! 密码的实际执行命令；溢出文件内容为远端输出，路径在应用私有目录下。

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use super::ticket::{truncate_display, CancelReason};

/// 每个作业在内存中保留的最近输出字节数（超出部分仅存磁盘溢出文件）。
pub(crate) const MAX_RING_BUFFER_BYTES: usize = 128 * 1024;

/// 作业状态。是 [`super::ticket::ExecutionStatus`] 在 Job 语境下的收敛视图：
/// 断连/失败 → `failed`，用户主动终止 → `killed`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Running,
    Completed,
    Killed,
    Failed,
}

impl JobStatus {
    /// 解析 `job_list(status=...)` 过滤参数；无法识别时返回 None（不过滤）。
    pub fn parse_filter(s: &str) -> Option<Self> {
        match s {
            "running" => Some(Self::Running),
            "completed" => Some(Self::Completed),
            "killed" => Some(Self::Killed),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

impl std::fmt::Display for JobStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Running => write!(f, "running"),
            Self::Completed => write!(f, "completed"),
            Self::Killed => write!(f, "killed"),
            Self::Failed => write!(f, "failed"),
        }
    }
}

/// 作业元数据（Tauri 事件与 `job_list` / `job_kill` 的载荷）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobInfo {
    pub job_id: String,
    pub session_id: String,
    pub task_id: Option<String>,
    pub description: String,
    /// 展示命令（截断），不含 sudo 密码。
    pub command: String,
    pub status: JobStatus,
    pub started_at_millis: u128,
    pub finished_at_millis: Option<u128>,
    pub total_output_bytes: usize,
}

/// `job_output` 的增量读取结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobOutputResult {
    pub job_id: String,
    /// 自 `offset` 起的新增输出。
    pub delta: String,
    /// 已读到的最新字节偏移（调用方下次传回）。
    pub offset: usize,
    pub status: JobStatus,
    /// 终止来源（仅 Killed/断连结算时有值）。调用方据此区分
    /// 界面用户终止、Agent job_kill、任务级联取消——
    /// `JobStatus::Killed` 本身不携带「谁终止的」信息。
    pub cancel_reason: Option<CancelReason>,
}

/// 单个作业的可变状态。调用方必须持有外层锁访问（见 manager 的 jobs 注册表）。
pub(crate) struct JobInstance {
    pub info: JobInfo,
    /// 关联的统一执行记录 exec_id（kill 时据此定位取消信号）。
    pub exec_id: u64,
    /// 最近输出的环形缓冲（最多 [`MAX_RING_BUFFER_BYTES`] 字节）。
    ring_buffer: VecDeque<u8>,
    /// 自启动以来累计收到的输出字节数。
    pub(crate) total_bytes_written: usize,
    /// 完整输出溢出文件（首个 chunk 到达时惰性创建）。
    spill_path: Option<PathBuf>,
    /// 终止来源。仅结算为 Killed/断连失败时落值（首次结算者为准）；
    /// `None` = 尚未结算或旧数据/未知来源，展示层必须保持中性文案。
    pub(crate) cancel_reason: Option<CancelReason>,
    /// 新输出/状态迁移通知（值 = total_bytes_written）。
    pub notify_tx: watch::Sender<usize>,
}

impl JobInstance {
    pub fn new(
        job_id: String,
        exec_id: u64,
        session_id: String,
        task_id: Option<String>,
        description: Option<String>,
        display_command: String,
        notify_tx: watch::Sender<usize>,
    ) -> Self {
        let now = now_millis();
        Self {
            info: JobInfo {
                job_id,
                session_id,
                task_id,
                description: description.unwrap_or_else(|| {
                    format!(
                        "Background execution of {}",
                        truncate_display(&display_command)
                    )
                }),
                command: truncate_display(&display_command),
                status: JobStatus::Running,
                started_at_millis: now,
                finished_at_millis: None,
                total_output_bytes: 0,
            },
            exec_id,
            ring_buffer: VecDeque::with_capacity(1024),
            total_bytes_written: 0,
            spill_path: None,
            cancel_reason: None,
            notify_tx,
        }
    }

    /// 追加一段输出：写溢出文件 + 进环形缓冲 + 通知等待方。
    pub fn append_output(&mut self, bytes: &[u8], temp_dir: &std::path::Path) {
        if bytes.is_empty() {
            return;
        }

        if self.spill_path.is_none() {
            // 文件名带启动毫秒：job_id 计数器随进程重启归零，
            // 时间戳保证不会撞上旧进程遗留的同名溢出文件。
            let file_name = format!(
                "marcel-job-{}-{}.log",
                self.info.job_id, self.info.started_at_millis
            );
            self.spill_path = Some(temp_dir.join(file_name));
        }
        if let Some(ref path) = self.spill_path {
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
                let _ = file.write_all(bytes);
            }
        }

        for &b in bytes {
            if self.ring_buffer.len() >= MAX_RING_BUFFER_BYTES {
                self.ring_buffer.pop_front();
            }
            self.ring_buffer.push_back(b);
        }

        self.total_bytes_written += bytes.len();
        self.info.total_output_bytes = self.total_bytes_written;
        let _ = self.notify_tx.send(self.total_bytes_written);
    }

    /// 从 `from_offset` 读取增量输出。窗口内走环形缓冲，历史部分从
    /// 溢出文件补齐；两者都不可用时尽力返回缓冲内全部内容。
    pub fn read_output_from(&self, from_offset: usize) -> (String, usize) {
        if from_offset >= self.total_bytes_written {
            return (String::new(), self.total_bytes_written);
        }

        let bytes_available = self.total_bytes_written - from_offset;
        let ring_start_offset = self
            .total_bytes_written
            .saturating_sub(self.ring_buffer.len());

        if from_offset >= ring_start_offset {
            let local_start = from_offset - ring_start_offset;
            let (part1, part2) = self.ring_buffer.as_slices();
            let mut out = Vec::with_capacity(bytes_available);
            if local_start < part1.len() {
                out.extend_from_slice(&part1[local_start..]);
                out.extend_from_slice(part2);
            } else {
                let p2_start = local_start - part1.len();
                if p2_start < part2.len() {
                    out.extend_from_slice(&part2[p2_start..]);
                }
            }
            return (
                String::from_utf8_lossy(&out).to_string(),
                self.total_bytes_written,
            );
        }

        if let Some(ref path) = self.spill_path {
            if let Ok(mut file) = File::open(path) {
                if file.seek(SeekFrom::Start(from_offset as u64)).is_ok() {
                    let mut buf = vec![0u8; bytes_available];
                    if let Ok(n) = file.read(&mut buf) {
                        return (
                            String::from_utf8_lossy(&buf[..n]).to_string(),
                            from_offset + n,
                        );
                    }
                }
            }
        }

        // 溢出文件读取失败的兜底：返回环形缓冲内现有内容。
        let (p1, p2) = self.ring_buffer.as_slices();
        let mut out = Vec::new();
        out.extend_from_slice(p1);
        out.extend_from_slice(p2);
        (
            String::from_utf8_lossy(&out).to_string(),
            self.total_bytes_written,
        )
    }

    /// 结算作业状态。只在 `Running` 时生效（幂等）——`job_kill` 与
    /// 执行 worker 可能先后到达，以先到者为准。
    pub fn finalize(&mut self, status: JobStatus) {
        self.finalize_with_reason(status, None);
    }

    /// 带终止来源的结算。`reason` 只在首次结算生效时落值，与状态同用
    /// 「先到者为准」语义：`job_kill` 先落则 worker 后到的结算不改写。
    pub fn finalize_with_reason(&mut self, status: JobStatus, reason: Option<CancelReason>) {
        if self.info.status != JobStatus::Running {
            return;
        }
        self.info.status = status;
        self.cancel_reason = reason;
        self.info.finished_at_millis = Some(now_millis());
        let _ = self.notify_tx.send(self.total_bytes_written);
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个测试用独立 job_id + 独立临时子目录，避免溢出文件互相污染。
    fn instance(id: &str) -> JobInstance {
        let (tx, _) = watch::channel(0);
        JobInstance::new(
            id.into(),
            1,
            "sess_1".into(),
            None,
            Some("test job".into()),
            "echo hello".into(),
            tx,
        )
    }

    fn test_temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("marcel-job-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn ring_buffer_and_delta_read() {
        let temp = test_temp_dir("delta");
        let mut inst = instance("job_delta_1");

        inst.append_output(b"hello world\n", &temp);
        assert_eq!(inst.total_bytes_written, 12);

        let (delta, next_offset) = inst.read_output_from(0);
        assert_eq!(delta, "hello world\n");
        assert_eq!(next_offset, 12);

        inst.append_output(b"second line\n", &temp);
        assert_eq!(inst.total_bytes_written, 24);

        let (delta2, next_offset2) = inst.read_output_from(12);
        assert_eq!(delta2, "second line\n");
        assert_eq!(next_offset2, 24);

        // 超前 offset：空增量，原样返回总长
        let (delta3, off3) = inst.read_output_from(999);
        assert_eq!(delta3, "");
        assert_eq!(off3, 24);
    }

    #[test]
    fn ring_buffer_evicts_oldest_beyond_window() {
        let temp = test_temp_dir("evict");
        let mut inst = instance("job_evict_1");
        // 超过窗口大小，环形缓冲只留最近 MAX_RING_BUFFER_BYTES 字节
        let big = vec![b'x'; MAX_RING_BUFFER_BYTES + 4096];
        inst.append_output(&big, &temp);
        assert_eq!(inst.total_bytes_written, big.len());
        assert_eq!(inst.ring_buffer.len(), MAX_RING_BUFFER_BYTES);

        // 回读最早内容需要走溢出文件
        let (head, _) = inst.read_output_from(0);
        assert_eq!(head.len(), big.len());
        assert!(head.starts_with('x'));

        // 中段偏移同样可从溢出文件精确回读
        let (mid, _) = inst.read_output_from(1024);
        assert!(mid.starts_with('x'));
        assert_eq!(mid.len(), big.len() - 1024);
    }

    #[test]
    fn finalize_is_idempotent() {
        let mut inst = instance("job_fin_1");
        inst.finalize(JobStatus::Completed);
        assert_eq!(inst.info.status, JobStatus::Completed);
        // 后到的 kill / 断连结算不得覆盖已落定的状态
        inst.finalize(JobStatus::Killed);
        assert_eq!(inst.info.status, JobStatus::Completed);
        assert!(inst.info.finished_at_millis.is_some());
    }

    #[test]
    fn display_command_is_truncated_into_info() {
        let (tx, _) = watch::channel(0);
        let long = "a".repeat(300);
        let inst = JobInstance::new("job_disp_1".into(), 2, "s".into(), None, None, long, tx);
        assert!(inst.info.command.chars().count() <= 121);
        assert!(inst.info.description.contains("Background execution"));
    }

    #[test]
    fn parse_filter_matches_known_statuses_only() {
        assert_eq!(JobStatus::parse_filter("running"), Some(JobStatus::Running));
        assert_eq!(JobStatus::parse_filter("killed"), Some(JobStatus::Killed));
        assert_eq!(JobStatus::parse_filter("bogus"), None);
    }

    #[test]
    fn spill_file_name_is_unique_per_instance() {
        // 两个同 id 实例（模拟进程重启后计数器归零）应得到不同溢出文件名
        let a = instance("job_1");
        // 强制不同的启动毫秒
        std::thread::sleep(std::time::Duration::from_millis(2));
        let b = instance("job_1");
        assert_ne!(a.info.started_at_millis, b.info.started_at_millis);
        let dir = test_temp_dir("names");
        assert_ne!(
            dir.join(format!("marcel-job-job_1-{}.log", a.info.started_at_millis)),
            dir.join(format!("marcel-job-job_1-{}.log", b.info.started_at_millis))
        );
    }
}
