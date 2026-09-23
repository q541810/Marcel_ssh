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
//! - 溢出文件本身有上限 [`MAX_SPILL_BYTES`]：命令产出超过它的部分**无处
//!   可存**，回读时如实报 lossy，而不是拿内存尾巴冒充全量（见
//!   [`OutputRead`]）。
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

/// 每个作业磁盘溢出文件的上限。超过它就不再写入（内存尾巴继续滚动），
/// 超限事实由 [`OutputRead::lossy`] 如实上报。
///
/// 有上限是硬要求：后台作业跑的是编译、下载、常驻服务，一条 `yes`、
/// 一个刷屏的调试日志就能写出无界文件，把用户磁盘写满。宁可有界地丢，
/// 不要无界地存。
pub(crate) const MAX_SPILL_BYTES: usize = 64 * 1024 * 1024;

/// 一次输出回读的结果。
///
/// `lossy` 是**必须传给模型**的事实：它意味着本次没能给出请求区间里的
/// 全部内容（内存窗口已滑出、溢出文件又不可用/不完整）。以前这种情况
/// 会返回缓冲尾巴却照报「已读到总长」，调用方以为拿全了——那是在骗模型。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OutputRead {
    /// 本次返回的文本。
    pub text: String,
    /// `text` 第一个字节在整个输出流里的偏移。
    ///
    /// **分片续读必须按它推**（下一个 offset = `text_start_offset` + 本次
    /// 取走的字节数）：丢内容时文本起点在请求起点**之后**（只回尾巴时是
    /// 窗口起点），按请求起点推出来的偏移会落回已读过的那段之前，调用方
    /// 就会反复拿到同一段。文本为空（无新输出）时等于请求起点。
    pub text_start_offset: usize,
    /// 调用方下次应传回的偏移。
    pub next_offset: usize,
    /// 是否丢了内容（丢了就必须说，不许假装读全）。
    pub lossy: bool,
    /// 丢掉的字节数：本次回读里接不上的那段空洞（前缀与尾巴之间缺掉的
    /// 字节数）。请求起点本身就落在空洞里时，它等于「请求起点到本次文本
    /// 起点」的距离。`lossy=false` 时恒为 0。
    pub skipped_bytes: usize,
}

/// 作业状态。是 [`super::ticket::ExecutionStatus`] 在 Job 语境下的收敛视图：
/// 断连/失败 → `failed`，用户主动终止 → `killed`，
/// **应用退出**（通道随进程消失）→ `interrupted`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Running,
    Completed,
    Killed,
    Failed,
    /// 上一次应用运行时派发、应用退出时还没结束的作业。从台账恢复出来的
    /// 记录用它：**通道已经随着进程关闭**，之后的输出再也读不到了，
    /// 远端进程是否还在跑则无从得知（没人发过信号）。
    Interrupted,
}

impl JobStatus {
    /// 解析 `job_list(status=...)` 过滤参数；无法识别时返回 None（不过滤）。
    pub fn parse_filter(s: &str) -> Option<Self> {
        match s {
            "running" => Some(Self::Running),
            "completed" => Some(Self::Completed),
            "killed" => Some(Self::Killed),
            "failed" => Some(Self::Failed),
            "interrupted" => Some(Self::Interrupted),
            _ => None,
        }
    }

    /// 是否已经是终态（不再变化）。
    pub fn is_terminal(self) -> bool {
        self != Self::Running
    }
}

impl std::fmt::Display for JobStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Running => write!(f, "running"),
            Self::Completed => write!(f, "completed"),
            Self::Killed => write!(f, "killed"),
            Self::Failed => write!(f, "failed"),
            Self::Interrupted => write!(f, "interrupted"),
        }
    }
}

/// 作业元数据（Tauri 事件与 `job_list` / `job_kill` 的载荷）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobInfo {
    pub job_id: String,
    pub session_id: String,
    pub task_id: Option<String>,
    /// 归属对话（子 agent 派发的作业记在父对话名下）。作业台账与访问围栏
    /// 的键；老记录/无归属为 None（对任何调用方可见，见 manager 的围栏）。
    #[serde(default)]
    pub owner_conversation_id: Option<String>,
    pub description: String,
    /// 展示命令（截断），不含 sudo 密码。
    pub command: String,
    pub status: JobStatus,
    /// 结算细节：退出事实（`exit code: 3` / `signal: KILL`）、失败原因等。
    /// 无则缺省——展示层不得自行编造。
    #[serde(default)]
    pub detail: Option<String>,
    pub started_at_millis: u128,
    pub finished_at_millis: Option<u128>,
    pub total_output_bytes: usize,
}

impl JobInfo {
    /// 是否属于某个归属对话（`owner_conversation_id` 为 None = 老记录 /
    /// 无归属作业，对任何调用方可见——与 DSH 的 unowned 作业同规则）。
    pub fn owned_by_conversation(&self, conversation_id: &str) -> bool {
        match self.owner_conversation_id.as_deref() {
            Some(owner) => owner == conversation_id,
            None => true,
        }
    }
}

/// `job_output` 的增量读取结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobOutputResult {
    pub job_id: String,
    /// 自 `offset` 起的新增输出。
    pub delta: String,
    /// `delta` 第一个字节在整个输出流里的偏移（见
    /// [`OutputRead::text_start_offset`]）：分片续读时按它推下一个 `offset`，
    /// 不要用本次请求的 `offset` 推——丢内容时文本起点在请求起点之后。
    #[serde(default)]
    pub text_start_offset: usize,
    /// 已读到的最新字节偏移（调用方下次传回）。
    pub offset: usize,
    pub status: JobStatus,
    /// 结算细节（退出码 / 信号 / 失败原因），无则缺省。
    #[serde(default)]
    pub detail: Option<String>,
    /// 终止来源（仅 Killed/断连结算时有值）。调用方据此区分
    /// 界面用户终止、Agent job_kill、任务级联取消——
    /// `JobStatus::Killed` 本身不携带「谁终止的」信息。
    pub cancel_reason: Option<CancelReason>,
    /// 本次回读是否丢了内容（内存窗口滑出且溢出文件不可用/不完整）。
    /// **调用方必须把它转达给模型**：丢了就说丢了，不能假装读全。
    #[serde(default)]
    pub lossy: bool,
    /// 丢掉的字节数（本次回读里接不上的那段空洞：前缀与尾巴之间缺掉的
    /// 字节数；请求起点就落在空洞里时＝请求起点到本次文本起点的距离）。
    #[serde(default)]
    pub skipped_bytes: usize,
    /// 完整输出的落点（溢出文件），仅在确实写下过内容时有值。
    /// 文件在用户本机（应用私有目录），模型读不到，只用于告知与排障。
    #[serde(default)]
    pub spill_path: Option<String>,
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
    /// 已写入溢出文件的字节数（达 [`MAX_SPILL_BYTES`] 后停止写入）。
    spill_bytes: usize,
    /// 溢出文件是否已放弃（超上限，或写入失败已警告过）。
    spill_abandoned: bool,
    /// 终止来源。仅结算为 Killed/断连失败时落值（首次结算者为准）；
    /// `None` = 尚未结算或旧数据/未知来源，展示层必须保持中性文案。
    pub(crate) cancel_reason: Option<CancelReason>,
    /// 新输出/状态迁移通知（值 = total_bytes_written）。
    pub notify_tx: watch::Sender<usize>,
    /// 结算通知是否已投递给所属 agent（等价 DSH 的 reported）。
    /// 置位后该作业不再产生新的「已完成」通知；`job_output(wait=true)`
    /// 等到结算与 agent 循环挂起消费都会置位，防重复注入。
    pub(crate) settled_notified: bool,
}

impl JobInstance {
    pub fn new(
        job_id: String,
        exec_id: u64,
        session_id: String,
        task_id: Option<String>,
        owner_conversation_id: Option<String>,
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
                owner_conversation_id,
                description: description.unwrap_or_else(|| {
                    format!(
                        "Background execution of {}",
                        truncate_display(&display_command)
                    )
                }),
                command: truncate_display(&display_command),
                status: JobStatus::Running,
                detail: None,
                started_at_millis: now,
                finished_at_millis: None,
                total_output_bytes: 0,
            },
            exec_id,
            ring_buffer: VecDeque::with_capacity(1024),
            total_bytes_written: 0,
            spill_path: None,
            spill_bytes: 0,
            spill_abandoned: false,
            cancel_reason: None,
            notify_tx,
            settled_notified: false,
        }
    }

    /// 从台账恢复一条上一次应用运行的作业。
    ///
    /// 恢复出来的记录只有「当时抓到的输出」（溢出文件）+ 结束时的状态：
    /// 通道随进程消失，之后再也没有新输出；环形缓冲是空的（进程内资源），
    /// 回读一律走溢出文件。`settled_notified` 直接置位——上一次运行的作业
    /// 绝不该给这一轮的对话注入「作业已完成」通知。
    pub fn restore(
        info: JobInfo,
        spill_path: Option<PathBuf>,
        captured_bytes: usize,
        cancel_reason: Option<CancelReason>,
    ) -> Self {
        let (notify_tx, _) = watch::channel(captured_bytes);
        Self {
            info: JobInfo {
                total_output_bytes: captured_bytes,
                ..info
            },
            // 恢复的作业没有可取消的 exec（那条通道早没了）。
            exec_id: 0,
            ring_buffer: VecDeque::new(),
            total_bytes_written: captured_bytes,
            spill_bytes: captured_bytes,
            spill_path,
            // 溢出文件若写不动/不存在，回读会如实报 lossy。
            spill_abandoned: false,
            cancel_reason,
            notify_tx,
            settled_notified: true,
        }
    }

    /// 追加一段输出：写溢出文件 + 进环形缓冲 + 通知等待方。
    ///
    /// 溢出文件达 [`MAX_SPILL_BYTES`] 后停止写入并只记一次警告：内存尾巴
    /// 继续滚动（诊断价值集中在尾部），超出的部分回读时如实报 lossy。
    pub fn append_output(&mut self, bytes: &[u8], temp_dir: &std::path::Path) {
        if bytes.is_empty() {
            return;
        }

        if self.spill_path.is_none() {
            self.spill_path = Some(temp_dir.join(spill_file_name(
                &self.info.job_id,
                self.info.started_at_millis,
            )));
        }
        if !self.spill_abandoned {
            self.spill_bytes = self.write_spill(bytes);
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

    /// 把一段输出追加进溢出文件，返回文件新增后的总字节数。达到上限或
    /// 写入失败时放弃溢出（后续只保留内存尾巴），并各自警告一次。
    fn write_spill(&mut self, bytes: &[u8]) -> usize {
        let Some(path) = self.spill_path.clone() else {
            return self.spill_bytes;
        };
        if self.spill_bytes >= MAX_SPILL_BYTES {
            self.spill_abandoned = true;
            log::warn!(
                "command_exec: 作业 {} 输出超过溢出上限（{} MB），之后的内容只保留内存尾巴",
                self.info.job_id,
                MAX_SPILL_BYTES / (1024 * 1024)
            );
            return self.spill_bytes;
        }
        // 只写到上限，不写超出的部分（宁可截断也不留无界文件）。
        let remaining = MAX_SPILL_BYTES - self.spill_bytes;
        let to_write = &bytes[..bytes.len().min(remaining)];
        match OpenOptions::new().create(true).append(true).open(&path) {
            Ok(mut file) => {
                if let Err(e) = file.write_all(to_write) {
                    self.spill_abandoned = true;
                    log::warn!(
                        "command_exec: 作业 {} 溢出文件写入失败（{}），之后的内容只保留内存尾巴",
                        self.info.job_id,
                        e
                    );
                    return self.spill_bytes;
                }
                self.spill_bytes + to_write.len()
            }
            Err(e) => {
                // 目录不存在 / 权限不足：只警告一次，不打断作业。
                self.spill_abandoned = true;
                log::warn!(
                    "command_exec: 作业 {} 溢出文件不可用（{}: {}），之后的内容只保留内存尾巴",
                    self.info.job_id,
                    path.display(),
                    e
                );
                self.spill_bytes
            }
        }
    }

    /// 溢出文件的落点（可能不存在——写入被放弃或目录不可用）。台账与
    /// 提示文案据此告诉调用方「完整输出在哪」。
    pub fn spill_path(&self) -> Option<&std::path::Path> {
        self.spill_path.as_deref()
    }

    /// 溢出文件里实际保住的字节数（≤ [`MAX_SPILL_BYTES`]）。
    pub fn spill_bytes(&self) -> usize {
        self.spill_bytes
    }

    /// 从 `from_offset` 读取增量输出。
    ///
    /// 覆盖关系（按字节）：溢出文件覆盖 `[0, spill_cover)`，环形缓冲覆盖
    /// `[ring_start, total)`。两者相接时一次给全；中间有空洞时给出能给的
    /// 部分 + 尾巴，并把空洞大小如实放进 [`OutputRead::skipped_bytes`]。
    /// **绝不拿尾巴冒充全量**——调用方据此告诉模型「这段读不到了」。
    ///
    /// 返回文本的真实起点由 [`OutputRead::text_start_offset`] 给出（可能与
    /// `from_offset` 不同：空洞截在请求起点前面时文本从尾巴起点开始）。
    pub fn read_output_from(&self, from_offset: usize) -> OutputRead {
        let total = self.total_bytes_written;
        if from_offset >= total {
            return OutputRead {
                text: String::new(),
                text_start_offset: from_offset,
                next_offset: total,
                lossy: false,
                skipped_bytes: 0,
            };
        }

        let ring_start = total.saturating_sub(self.ring_buffer.len());
        if from_offset >= ring_start {
            // 请求区间整段都在内存窗口里：直读，无损。
            let local_start = from_offset - ring_start;
            let (part1, part2) = self.ring_buffer.as_slices();
            let mut out = Vec::with_capacity(total - from_offset);
            if local_start < part1.len() {
                out.extend_from_slice(&part1[local_start..]);
                out.extend_from_slice(part2);
            } else {
                let p2_start = local_start - part1.len();
                if p2_start < part2.len() {
                    out.extend_from_slice(&part2[p2_start..]);
                }
            }
            return OutputRead {
                text: String::from_utf8_lossy(&out).to_string(),
                text_start_offset: from_offset,
                next_offset: total,
                lossy: false,
                skipped_bytes: 0,
            };
        }

        // 起点在窗口之外：先尽力从溢出文件补上 [from_offset, ring_start)。
        let spill_cover = self.spill_cover_end();
        let mut text = String::new();
        let mut next = from_offset;
        // 返回文本的起点：默认就是请求起点；一段前缀都没补上时改记尾巴起点。
        let mut text_start_offset = from_offset;
        if from_offset < spill_cover {
            let want = spill_cover.min(ring_start) - from_offset;
            // 读不到就保持 next 不动：下面的尾巴分支会把它当作空洞如实报出。
            if let Some((chunk, n)) =
                read_spill_range(self.spill_path.as_deref(), from_offset, want)
            {
                if n > 0 {
                    text.push_str(&chunk);
                    next = from_offset + n;
                }
            }
        }

        // 尾巴（内存窗口覆盖的那一段）一定接上——诊断价值集中在尾部。
        let (p1, p2) = self.ring_buffer.as_slices();
        let mut out = Vec::with_capacity(p1.len() + p2.len());
        out.extend_from_slice(p1);
        out.extend_from_slice(p2);
        let tail = String::from_utf8_lossy(&out).to_string();

        if next < ring_start {
            // 中间还缺一段（溢出文件没覆盖到窗口起点：超上限 / 没写成 / 不见了）
            let skipped = ring_start - next;
            if text.is_empty() {
                // 前缀一段都没补上：文本就是这根尾巴，起点是窗口起点
                // （续读偏移据此推，不能拿请求起点推）。
                text_start_offset = ring_start;
            }
            text.push_str(&tail);
            return OutputRead {
                text,
                text_start_offset,
                next_offset: total,
                lossy: true,
                skipped_bytes: skipped,
            };
        }

        // 无缝接上：一次给到末尾，无损。
        text.push_str(&tail);
        OutputRead {
            text,
            text_start_offset,
            next_offset: total,
            lossy: false,
            skipped_bytes: 0,
        }
    }

    /// 溢出文件实际覆盖到的偏移（以文件真实长度为准，而不是内存里记的
    /// 计数——恢复回来的作业、写到一半崩溃的作业都靠文件长度说话）。
    fn spill_cover_end(&self) -> usize {
        let Some(path) = self.spill_path.as_deref() else {
            return 0;
        };
        std::fs::metadata(path)
            .map(|m| m.len() as usize)
            .unwrap_or(0)
            .min(self.total_bytes_written)
    }

    /// 结算作业状态。只在 `Running` 时生效（幂等）：这里落下的终态即最终
    /// 状态，后到的结算（worker / kill / 断连）一律不改写。
    pub fn finalize(&mut self, status: JobStatus) {
        self.finalize_with_reason(status, None);
    }

    /// 带终止来源的结算。`reason` 只在首次结算生效时落值，与状态一起锁定。
    ///
    /// 「先到者为准」只覆盖**都走到本方法**的结算方。worker 的收尾顺序是
    /// 「先把执行记录摘出运行表，再落作业终态」，两件事之间的窗口里到达的
    /// `kill_job` 不再落 `Killed`（它发现 exec 已离开运行表就只如实返回记录，
    /// 见 `manager.rs` 的 `kill_job`）——否则会把一条其实已经成功结束的作业记成
    /// 被终止，并把 worker 带着退出细节的那次结算幂等挡掉。
    pub fn finalize_with_reason(&mut self, status: JobStatus, reason: Option<CancelReason>) {
        if self.info.status != JobStatus::Running {
            return;
        }
        self.info.status = status;
        self.cancel_reason = reason;
        self.info.finished_at_millis = Some(now_millis());
        let _ = self.notify_tx.send(self.total_bytes_written);
    }

    /// 结算并附上退出事实等细节（只在 `Running` 时生效，语义同上）。
    pub fn finalize_with_detail(
        &mut self,
        status: JobStatus,
        reason: Option<CancelReason>,
        detail: Option<String>,
    ) {
        if self.info.status != JobStatus::Running {
            return;
        }
        self.finalize_with_reason(status, reason);
        self.info.detail = detail.filter(|d| !d.is_empty());
    }
}

/// 输出溢出文件的文件名。
///
/// 确定性命名（job_id + 启动毫秒，时间戳用来避开进程重启后计数器归零带
/// 来的同名文件）：**落台账时就要写出这个名字**，否则应用在作业跑着时
/// 退出，重启后就没有路径可指、退出前抓到的输出也就找不回来了。
/// 命名规则只此一处。
pub(crate) fn spill_file_name(job_id: &str, started_at_millis: u128) -> String {
    format!("marcel-job-{}-{}.log", job_id, started_at_millis)
}

/// 从溢出文件读 `[from_offset, from_offset + want)`；返回（文本、实际读到的
/// 字节数）。文件不可用（不存在 / 打不开 / seek 失败）返回 None。
fn read_spill_range(
    path: Option<&std::path::Path>,
    from_offset: usize,
    want: usize,
) -> Option<(String, usize)> {
    let path = path?;
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(from_offset as u64)).ok()?;
    let mut buf = vec![0u8; want];
    let n = file.read(&mut buf).ok()?;
    Some((String::from_utf8_lossy(&buf[..n]).to_string(), n))
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
            Some("conv_1".into()),
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

        let read = inst.read_output_from(0);
        assert_eq!(read.text, "hello world\n");
        assert_eq!(read.next_offset, 12);
        assert_eq!(read.text_start_offset, 0);
        assert!(!read.lossy);

        inst.append_output(b"second line\n", &temp);
        assert_eq!(inst.total_bytes_written, 24);

        let read2 = inst.read_output_from(12);
        assert_eq!(read2.text, "second line\n");
        assert_eq!(read2.next_offset, 24);
        // 无空洞路径：文本起点就是请求起点（续读偏移的对照基准）
        assert_eq!(read2.text_start_offset, 12);
        assert!(!read2.lossy);

        // 超前 offset：空增量，原样返回总长
        let read3 = inst.read_output_from(999);
        assert_eq!(read3.text, "");
        assert_eq!(read3.next_offset, 24);
        assert_eq!(read3.text_start_offset, 999);
        assert!(!read3.lossy);
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

        // 回读最早内容需要走溢出文件，且必须读全（lossy = false）
        let head = inst.read_output_from(0);
        assert_eq!(head.text.len(), big.len());
        assert!(head.text.starts_with('x'));
        assert_eq!(head.text_start_offset, 0);
        assert!(!head.lossy);

        // 中段偏移同样可从溢出文件精确回读
        let mid = inst.read_output_from(1024);
        assert!(mid.text.starts_with('x'));
        assert_eq!(mid.text.len(), big.len() - 1024);
        assert_eq!(mid.text_start_offset, 1024);
        assert!(!mid.lossy);
    }

    #[test]
    fn missing_spill_file_reports_lossy_tail() {
        // 溢出目录不存在（= 生产里"目录没建 / 写失败"的情形）：
        // 回读超窗口内容时必须如实报 lossy，而不是拿内存尾巴冒充全量。
        let temp = test_temp_dir("no-spill-dir").join("absent");
        let mut inst = instance("job_lossy_1");
        let big = vec![b'y'; MAX_RING_BUFFER_BYTES + 4096];
        inst.append_output(&big, &temp);
        assert!(!temp.exists());
        assert_eq!(inst.spill_bytes(), 0);

        let read = inst.read_output_from(0);
        assert!(read.lossy, "溢出文件不可用必须标记 lossy");
        // 尾巴仍然是可用的近似（诊断价值在尾部），偏移推进到总长
        assert_eq!(read.text.len(), MAX_RING_BUFFER_BYTES);
        // 一段前缀都没补上：返回文本就是尾巴，起点是窗口起点而不是请求起点
        assert_eq!(read.text_start_offset, big.len() - MAX_RING_BUFFER_BYTES);
        assert_eq!(read.skipped_bytes, big.len() - MAX_RING_BUFFER_BYTES);
        assert_eq!(read.next_offset, big.len());

        // 窗口内的读不受影响，也不算 lossy
        let tail = inst.read_output_from(big.len() - 10);
        assert_eq!(tail.text.len(), 10);
        assert!(!tail.lossy);
        assert_eq!(tail.text_start_offset, big.len() - 10);
        assert_eq!(tail.skipped_bytes, 0);
    }

    /// 分片续读的回归：溢出文件不可用 + 内存尾巴大于调用方单次回读上限时，
    /// 尾巴必须能沿「文本起点 + 已取走字节数」一段段读完，第二段不能重复
    /// 第一段的内容。
    ///
    /// 曾经的算法把续读偏移算成「请求 offset + 已取走字节数」——丢内容时
    /// 返回文本的起点是窗口起点（`ring_start`），比请求起点靠后一大截，
    /// 于是每次续读都落回尾巴开头，模型反复拿到同一段首字节。
    #[test]
    fn lossy_tail_read_resumes_from_the_tail_start_without_repeating() {
        let temp = test_temp_dir("lossy-chunk").join("absent");
        let mut inst = instance("job_lossy_chunk_1");
        // 尾巴的前 32KB 是 'A'、其余是 'B'：一旦重复读，第二段又会以 'A' 开头。
        let cut = 32_000;
        let mut body = vec![b'A'; cut];
        body.extend(std::iter::repeat(b'B').take(MAX_RING_BUFFER_BYTES - cut));
        inst.append_output(&vec![b'x'; MAX_RING_BUFFER_BYTES], &temp);
        inst.append_output(&body, &temp);
        assert!(!temp.exists());
        assert_eq!(inst.total_bytes_written, MAX_RING_BUFFER_BYTES + body.len());

        let first = inst.read_output_from(0);
        assert!(first.lossy);
        assert_eq!(first.text_start_offset, MAX_RING_BUFFER_BYTES);
        assert!(first.text.starts_with('A'));

        // 调用方按新规则分片：取走前 cut 字节，续读 offset = 文本起点 + 已取走字节数
        let first_chunk = &first.text[..cut];
        let second = inst.read_output_from(first.text_start_offset + first_chunk.len());
        assert_eq!(second.text_start_offset, MAX_RING_BUFFER_BYTES + cut);
        assert!(second.text.starts_with('B'), "续读不能重复已读过的尾巴开头");
        assert!(!second.lossy);
        // 两段拼起来正好是那根尾巴（一次不多、一次不少）
        assert_eq!(first_chunk.len() + second.text.len(), MAX_RING_BUFFER_BYTES);
    }

    #[test]
    fn spill_is_capped_and_reports_the_gap() {
        let temp = test_temp_dir("cap");
        let mut inst = instance("job_cap_1");
        // 写入超过溢出上限的内容：文件必须停在 MAX_SPILL_BYTES
        let chunk = vec![b'z'; 1024 * 1024];
        for _ in 0..(MAX_SPILL_BYTES / chunk.len() + 2) {
            inst.append_output(&chunk, &temp);
        }
        assert!(inst.total_bytes_written > MAX_SPILL_BYTES);
        assert_eq!(inst.spill_bytes(), MAX_SPILL_BYTES);

        let spill = inst.spill_path().expect("溢出路径应已登记").to_path_buf();
        assert_eq!(
            std::fs::metadata(&spill).unwrap().len(),
            MAX_SPILL_BYTES as u64
        );

        // 溢出上限之外、内存窗口之前的那一段是真丢了：读全量必须报 lossy，
        // 并把空洞大小说清楚（这里 = 窗口起点 - 溢出覆盖终点）。
        let ring_start = inst.total_bytes_written - MAX_RING_BUFFER_BYTES;
        let gap = ring_start - MAX_SPILL_BYTES;
        let early = inst.read_output_from(0);
        assert!(early.lossy, "溢出上限之外的内容读不到，必须报 lossy");
        assert_eq!(early.skipped_bytes, gap);
        // 能读到的部分 = 溢出文件覆盖的全部 + 内存尾巴（一次给到位）
        assert_eq!(early.text.len(), MAX_SPILL_BYTES + MAX_RING_BUFFER_BYTES);
        assert_eq!(early.next_offset, inst.total_bytes_written);
        // 前缀补上了：文本从请求起点开始（空洞夹在文本中间）
        assert_eq!(early.text_start_offset, 0);

        // 从空洞起点读：仍然拿得到尾巴，空洞照实报
        let beyond = inst.read_output_from(MAX_SPILL_BYTES);
        assert!(beyond.lossy);
        assert_eq!(beyond.skipped_bytes, gap);
        assert_eq!(beyond.text.len(), MAX_RING_BUFFER_BYTES);
        // 这段前缀一段都没补上：文本就是尾巴，起点是窗口起点
        assert_eq!(beyond.text_start_offset, ring_start);
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
        let inst = JobInstance::new("job_disp_1".into(), 2, "s".into(), None, None, None, long, tx);
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
