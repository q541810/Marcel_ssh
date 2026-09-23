//! 作业台账：跨应用运行的持久记录。
//!
//! 后台作业的**在册状态**是进程内的（`manager.rs` 的 jobs 注册表）——SSH
//! 通道、环形缓冲、结算通知都随进程存在。台账补的正是这部分：
//!
//! 1. **job_id 序号水位**跨运行单调递增。`job_id` 原本由进程内计数器发放，
//!    应用重启后从 1 重数，同一个对话历史里就会出现两个不同的 `job_1`——
//!    模型拿历史里记着的旧 id 去回读，读到的却是这次运行新作业的输出
//!    （`job.rs` 的溢出文件名带启动毫秒，正是为了躲开这类"同名不同物"的
//!    碰撞，但那只堵住了文件层）。序号不回头，旧 id 就永远不会指向新作业。
//! 2. **作业记录本身**（谁派的、什么命令、什么结局、抓到多少输出、输出
//!    落在哪）跨运行保留。重启后 `job_list` 认得出「上一次运行派发的作业」，
//!    `job_output` 还能把退出前抓到的输出读出来。
//!
//! 能恢复的天花板要说清：通道随进程没了，之后的输出再也读不到；远端进程
//! 是否还在跑更无从得知（没人给它发过信号）。所以恢复出来的作业一律是
//! [`super::job::JobStatus::Interrupted`]，并把这两件事写在文案里。
//! DSH 的作业注册表是 process-local 的，它自己写着「跨运行时重启存活需要
//! 另一套 durable-job 设计」——这里就是那套设计里落盘的那一半。
//!
//! 落盘约定：
//! - 文件在应用配置目录下（[`LEDGER_FILE_NAME`]），走 `atomic_write`
//!   （tmp + fsync + rename），半个文件不会被读到；
//! - 写失败（磁盘满 / 权限）**不影响执行**：作业照跑，只记一条 warn——
//!   台账是序号水位与历史记录，不是执行的必需品；
//! - 解析失败或读不动（权限 / 共享冲突 / 非 UTF-8）时，先把原文件隔离成
//!   `.bak` 再从空台账起步；连隔离都做不到就封盘（本次运行不写盘），
//!   绝不静默删除、也绝不覆盖用户目录里那份还没被保住的文件；
//! - 单条记录坏掉不算整份损坏：`jobs` 逐条解析，坏的丢自己（见
//!   [`deserialize_jobs`]），水位与其余记录照旧——水位是台账最不可失守的
//!   不变式，任何单条记录都不该有本事把它抹掉。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use parking_lot::Mutex as PlMutex;
use serde::de::Error as DeError;
use serde::{Deserialize, Serialize};

use crate::config::persist::atomic_write;

use super::job::JobStatus;
use super::ticket::CancelReason;

/// 台账文件名（应用配置目录下）。
pub const LEDGER_FILE_NAME: &str = "jobs.json";

/// 已结束作业的保留期：超过它就从台账里清掉（连同它的溢出文件）。
/// 保留期的意义是「还能回看最近的作业」，不是永久归档；无限留着只会让
/// 台账与磁盘占用一直涨。
pub(crate) const RETENTION_MILLIS: u128 = 7 * 24 * 60 * 60 * 1000;

/// 台账条目上限（超出后按结束时间从旧到新丢已结束的条目）。
pub(crate) const MAX_LEDGER_JOBS: usize = 500;

/// 台账里的一条作业记录。
///
/// 字段与 [`super::job::JobInfo`] 对齐（外加输出落点与已抓字节数），
/// 改动任何一边都要同步另一边——恢复出来的作业就是拿它拼回 JobInfo 的。
///
/// **写者与读者的字段集必须一致**：写只有两个入口（`manager::record_job_started`
/// 派发、`manager::record_job_settled` 结算——含 panic 兜底），读只有两个出口
/// （`manager::recover_ledger_jobs` 启动恢复、`manager::project_ledger_entry`
/// 运行期回退）。这条规矩不是形式主义：出过的两次事故都是「写者只写一半、
/// 读者按另一半还原」——`cancel_reason` 没有任何结算路径回写（重启后丢掉
/// 「谁终止的」），`captured_bytes` 没有任何读路径使用（输出丢了却报无损）。
/// 两次都要等重启才暴露。加/改字段时先回答三件事：**谁写、谁读、哪条测试
/// 能证明这一跳**；没有测试覆盖的那一半，只会在下次重启时给你惊喜。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LedgerJob {
    pub job_id: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub owner_conversation_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub command: String,
    /// 结局。缺字段（旧版本写的、外部改坏的）按「结局未知」读成 interrupted，
    /// 绝不默认成 completed——不知道结局时，说「在上一次运行里中断了」比
    /// 说「成功完成」诚实（恢复路径对 running 的处置也是这个结论）。
    #[serde(default = "unknown_status_default")]
    pub status: JobStatus,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub started_at_millis: u128,
    #[serde(default)]
    pub finished_at_millis: Option<u128>,
    /// 结算时真正抓到的输出字节数（只由 `record_job_settled` 更新；派发时
    /// 是 0）。**读路径必须用它**——溢出文件长度只是它的下界，见
    /// [`Self::captured_total`]。
    #[serde(default)]
    pub captured_bytes: usize,
    /// 输出溢出文件的落点（本机应用私有目录）。
    #[serde(default)]
    pub spill_path: Option<String>,
    #[serde(default)]
    pub cancel_reason: Option<CancelReason>,
}

/// `status` 缺字段时的默认值：结局未知，按「上一次运行没结算完」呈现。
///
/// 不取 `completed`：那是把「不知道」说成「成功」。不取 `running` 也不行
/// ——台账里的 `running` 是「这次运行正在跑」的声明，会让保留期清理永远
/// 不碰它，还会让恢复路径每次重启都重写一遍。
fn unknown_status_default() -> JobStatus {
    JobStatus::Interrupted
}

impl LedgerJob {
    /// 这条记录「一共抓到多少输出」的事实：台账计数与溢出文件长度**取大者**。
    ///
    /// 两个来源都可能偏小，谁也不该顶掉对方：
    /// - 溢出文件会被 [`super::job::MAX_SPILL_BYTES`] 截断、可能写到一半失败、
    ///   或被外部清掉 → 文件长度偏小；
    /// - 应用在作业跑着的时候退出 / 崩溃时 `record_job_settled` 没跑，
    ///   台账计数还停在派发那一刻的 0 → 计数偏小。
    ///
    /// 取 max 就是「宁可多说，不可把已经抓到过的输出说没了」；真正读不全的
    /// 部分由 `lossy` 在回读时如实上报，不许拿「文件长度」当无损的证据。
    pub(crate) fn captured_total(&self, spill_file_len: usize) -> usize {
        self.captured_bytes.max(spill_file_len)
    }

    /// 从一条记录拼回可展示的作业元数据（恢复路径）。
    ///
    /// `spill_file_len` 是溢出文件**当前**的字节数（调用方读文件得到；
    /// 形参刻意不叫 `captured_bytes`，免得再遮蔽同名字段、再出一次
    /// 「读的是谁」的事故）。
    pub(crate) fn to_info(&self, spill_file_len: usize) -> super::job::JobInfo {
        super::job::JobInfo {
            job_id: self.job_id.clone(),
            session_id: self.session_id.clone(),
            task_id: self.task_id.clone(),
            owner_conversation_id: self.owner_conversation_id.clone(),
            description: self.description.clone(),
            command: self.command.clone(),
            status: self.status,
            detail: self.detail.clone(),
            started_at_millis: self.started_at_millis,
            finished_at_millis: self.finished_at_millis,
            total_output_bytes: self.captured_total(spill_file_len),
        }
    }
}

/// 台账内容。字段全部 `#[serde(default)]`（`jobs` 还额外逐条容错）：
/// 旧版本写的文件缺少新字段时按默认值读进来，不报错、不重置。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct JobLedger {
    /// 已发放的最大 job 序号。进程内的取号从它往后数。
    #[serde(default)]
    pub next_job_num: u64,
    /// 作业记录（新在后）。
    #[serde(default, deserialize_with = "deserialize_jobs")]
    pub jobs: Vec<LedgerJob>,
}

/// `jobs` 的逐条容错反序列化。
///
/// 单条记录坏掉（缺 `job_id`、`status` 不是已知取值、字段类型不对）只丢那
/// 一条，**不许让整份台账解析失败**：`load` 会把整份解析失败当「文件损坏」
/// 隔离，并从 0 重新发号——代价是旧 `job_id` 可能被重用（模型历史里记着的
/// `job_3` 会指到另一个作业上），比丢一条记录严重得多。水位（`next_job_num`）
/// 是台账最不可失守的不变式，任何单条记录都不该有本事把它抹掉。
///
/// 唯一的例外是 `jobs` 整个不是数组：那已经解释不出「哪条坏、哪条好」，
/// 交给上层按损坏处理（隔离 + 保留原文件），而不是当空表接着往下写。
fn deserialize_jobs<'de, D>(deserializer: D) -> Result<Vec<LedgerJob>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(deserializer)?;
    let serde_json::Value::Array(items) = raw else {
        return Err(DeError::custom("jobs 不是数组"));
    };
    let mut jobs = Vec::with_capacity(items.len());
    let mut dropped = 0usize;
    for item in items {
        match serde_json::from_value::<LedgerJob>(item) {
            // 缺 `job_id` 的记录无法命名，任何读路径（job_output / job_status
            // / job_kill）都定位不到它，留着只会变成一条空 id 的幽灵作业。
            Ok(job) if job.job_id.is_empty() => {
                dropped += 1;
                log::warn!("command_exec: 作业台账里有一条没有 job_id 的记录，已忽略");
            }
            Ok(job) => jobs.push(job),
            Err(e) => {
                dropped += 1;
                log::warn!(
                    "command_exec: 作业台账里有一条记录无法解析（{}），已忽略",
                    e
                );
            }
        }
    }
    if dropped > 0 {
        log::warn!(
            "command_exec: 作业台账忽略 {} 条无法解析的记录，其余记录与序号水位不受影响",
            dropped
        );
    }
    Ok(jobs)
}

/// 台账的内存镜像 + 串行落盘器。
pub(crate) struct JobLedgerStore {
    path: PathBuf,
    state: PlMutex<JobLedger>,
    /// 原文件读不动（或内容损坏）且**隔离失败**：本次运行拒绝写盘。
    ///
    /// 不给写盘留后路只有一个理由：[`JobLedgerStore::save_locked`] 走
    /// `atomic_write`（tmp + rename），一旦写下去，用户目录里那份读不动的
    /// 原文件就被整份替换掉了——那是数据销毁，而且不声不响（只有一条
    /// warn）。封盘后取号照常（进程内仍单调递增），只是不落盘：宁可这次
    /// 运行的序号不跨重启，也不要毁掉一份可能只是暂时读不到（权限、
    /// 共享冲突）或还能人工抢救的文件。
    sealed: bool,
}

impl JobLedgerStore {
    /// 读取台账。文件不存在 / 为空 → 空台账；解析失败或读不动 → 先把原
    /// 文件隔离成 `.bak` 再从空台账起步（原文件一个字节都不丢，也不静默
    /// 删除）；连隔离都做不到时封盘——见 [`Self::sealed`]。
    pub(crate) fn load(path: PathBuf) -> Self {
        let (state, sealed) = match read_ledger(&path) {
            Ok(ledger) => (ledger, false),
            Err(LoadError::Corrupt(raw)) => {
                quarantine_or_seal(&path, &format!("解析失败（{} 字节）", raw))
            }
            // 读不动 ≠ 损坏：权限、Windows 共享冲突、非 UTF-8 都会走到这里。
            // 旧实现只打一条 warn 就当空台账接着用，于是下一次
            // `allocate_job_num` 的 atomic_write 直接把它整份盖掉。
            Err(LoadError::Unreadable(err)) => {
                quarantine_or_seal(&path, &format!("读取失败（{}）", err))
            }
        };
        Self {
            path,
            state: PlMutex::new(state),
            sealed,
        }
    }

    /// 取号：序号水位 +1 并立刻落盘。返回的号一定大于本机所有历史运行
    /// 发放过的号；落盘失败时仍返回号（作业不能因此起不来），只记 warn。
    pub(crate) fn allocate_job_num(&self) -> u64 {
        let mut state = self.state.lock();
        state.next_job_num += 1;
        let num = state.next_job_num;
        if let Err(e) = self.save_locked(&state) {
            log::warn!(
                "command_exec: 作业序号水位落盘失败（{}）；本次运行仍从 {} 继续，但重启后可能重发已用过的 job_id",
                e,
                num
            );
        }
        num
    }

    /// 新增 / 覆盖一条作业记录并落盘。
    pub(crate) fn upsert(&self, entry: LedgerJob) {
        let mut state = self.state.lock();
        match state.jobs.iter_mut().find(|j| j.job_id == entry.job_id) {
            Some(existing) => *existing = entry,
            None => state.jobs.push(entry),
        }
        self.save_warn(&state);
    }

    /// 更新一条已存在的作业记录（找不到就忽略——记录可能已被清理）。
    pub(crate) fn update<F>(&self, job_id: &str, patch: F)
    where
        F: FnOnce(&mut LedgerJob),
    {
        let mut state = self.state.lock();
        if let Some(entry) = state.jobs.iter_mut().find(|j| j.job_id == job_id) {
            patch(entry);
            self.save_warn(&state);
        }
    }

    /// 台账里的全部记录（新在后）。
    pub(crate) fn entries(&self) -> Vec<LedgerJob> {
        self.state.lock().jobs.clone()
    }

    /// 按 job_id 取一条记录。运行期回退读路径用它（内存收敛把已结算作业
    /// 从在册表腾出去之后，台账里的记录仍要能被 `job_output` / `job_status`
    /// 找到），比 [`Self::entries`] 少克隆一份整表。
    pub(crate) fn entry(&self, job_id: &str) -> Option<LedgerJob> {
        self.state
            .lock()
            .jobs
            .iter()
            .find(|j| j.job_id == job_id)
            .cloned()
    }

    /// 按保留期与条目上限清理，返回**应该删掉的溢出文件路径**
    /// （调用方负责删除文件——文件系统操作不属于台账）。
    pub(crate) fn prune(&self, now_millis: u128) -> Vec<String> {
        let mut state = self.state.lock();
        let before = state.jobs.len();
        let mut dropped: Vec<String> = Vec::new();

        // 1) 超过保留期的已结束作业。运行中的记录不删——那是上一次运行
        //    还没结算的痕迹，恢复时要靠它认回来。
        state.jobs.retain(|j| {
            // 结束时间未知（中断在应用退出那一刻，没人来得及记）就退回开始
            // 时间——否则这类记录永远不满足保留期，只能等条目上限来兜。
            let stamp = j.finished_at_millis.unwrap_or(j.started_at_millis);
            let too_old = j.status.is_terminal()
                && now_millis.saturating_sub(stamp) > RETENTION_MILLIS;
            if too_old {
                dropped.extend(j.spill_path.clone());
            }
            !too_old
        });

        // 2) 条目上限：从最旧的已结束条目开始丢。
        if state.jobs.len() > MAX_LEDGER_JOBS {
            let mut terminal: Vec<usize> = state
                .jobs
                .iter()
                .enumerate()
                .filter(|(_, j)| j.status.is_terminal())
                .map(|(idx, _)| idx)
                .collect();
            terminal.sort_by_key(|idx| state.jobs[*idx].finished_at_millis.unwrap_or(u128::MAX));
            let mut drop_set: HashSet<usize> = HashSet::new();
            for idx in terminal {
                if state.jobs.len() - drop_set.len() <= MAX_LEDGER_JOBS {
                    break;
                }
                drop_set.insert(idx);
            }
            if !drop_set.is_empty() {
                let mut idx = 0usize;
                state.jobs.retain(|j| {
                    let keep = !drop_set.contains(&idx);
                    if !keep {
                        dropped.extend(j.spill_path.clone());
                    }
                    idx += 1;
                    keep
                });
            }
        }

        if state.jobs.len() != before {
            log::info!(
                "command_exec: 作业台账清理 {} 条旧记录（{} → {}）",
                before - state.jobs.len(),
                before,
                state.jobs.len()
            );
            self.save_warn(&state);
        }
        dropped
    }

    /// 落盘当前状态。调用方持锁调用。封盘（见 [`Self::sealed`]）时直接失败：
    /// 原文件读不动又隔离不掉，写下去就是把它整份替换掉。
    fn save_locked(&self, state: &JobLedger) -> Result<(), String> {
        if self.sealed {
            return Err(format!(
                "台账 {} 的原文件读不动且无法隔离，本次运行拒绝写盘（原文件保持原样）",
                self.path.display()
            ));
        }
        let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
        atomic_write(&self.path, &json).map_err(|e| e.to_string())
    }

    /// 落盘并只记一条 warn：台账是 best-effort，绝不能让作业执行失败。
    fn save_warn(&self, state: &JobLedger) {
        if let Err(e) = self.save_locked(state) {
            log::warn!("command_exec: 作业台账落盘失败（{}）", e);
        }
    }
}

/// 读取失败的两种情形。**处置相同**（隔离原文件，隔离不掉就封盘），
/// 分开只为把日志说准：损坏是内容问题，读不动是环境问题（权限 / 共享冲突 /
/// 非 UTF-8），排查方向完全不同。
enum LoadError {
    /// 文件存在但内容不是合法 JSON（附原始字节数）。
    Corrupt(usize),
    Unreadable(String),
}

fn read_ledger(path: &Path) -> Result<JobLedger, LoadError> {
    if !path.exists() {
        return Ok(JobLedger::default());
    }
    let content = std::fs::read_to_string(path).map_err(|e| LoadError::Unreadable(e.to_string()))?;
    if content.trim().is_empty() {
        return Ok(JobLedger::default());
    }
    serde_json::from_str(&content).map_err(|_| LoadError::Corrupt(content.len()))
}

/// 把损坏的台账挪到 `<name>.bak`，返回落点（失败返回 None）。
fn quarantine(path: &Path) -> Option<PathBuf> {
    let mut name = path.file_name()?.to_os_string();
    name.push(".bak");
    let backup = path.with_file_name(name);
    std::fs::rename(path, &backup).ok().map(|_| backup)
}

/// 台账读不成（损坏或读不动）时的收尾：**先保住原文件**，再决定能不能写。
///
/// - 隔离成功：原文件原样躺在 `.bak` 里（`atomic_write` 之后覆盖的是新
///   文件，与它无关），本次从空台账起步、照常落盘；
/// - 隔离失败（文件被占住 / 目录不可写）：返回封盘标记，本次运行只在内存
///   里记账——**绝不静默覆盖**那份还没被保住的文件。
///
/// 两种情况的共同底线是：原文件一个字节都不许动。
fn quarantine_or_seal(path: &Path, what: &str) -> (JobLedger, bool) {
    match quarantine(path) {
        Some(backup) => {
            log::warn!(
                "command_exec: 作业台账{}，已隔离到 {}，本次从空台账起步",
                what,
                backup.display()
            );
            (JobLedger::default(), false)
        }
        None => {
            log::warn!(
                "command_exec: 作业台账{}，且隔离失败（文件被占用或目录不可写）；\
                 本次从空台账起步并封盘：不写盘、原文件保持原样",
                what
            );
            (JobLedger::default(), true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个测试用独立临时目录，避免台账文件互相污染。
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "marcel-ledger-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    fn entry(job_id: &str, status: JobStatus, finished_at: Option<u128>) -> LedgerJob {
        LedgerJob {
            job_id: job_id.into(),
            session_id: "sess_1".into(),
            owner_conversation_id: Some("conv_1".into()),
            task_id: Some("task_1".into()),
            description: "build".into(),
            command: "cargo build".into(),
            status,
            detail: Some("exit code: 0".into()),
            started_at_millis: 1,
            finished_at_millis: finished_at,
            captured_bytes: 42,
            spill_path: Some(format!("/tmp/marcel-job-{}.log", job_id)),
            cancel_reason: None,
        }
    }

    #[test]
    fn missing_file_starts_at_zero() {
        let dir = temp_dir("missing");
        let store = JobLedgerStore::load(dir.join(LEDGER_FILE_NAME));
        assert_eq!(store.allocate_job_num(), 1);
        assert!(store.entries().is_empty());
    }

    #[test]
    fn job_num_and_entries_survive_reload() {
        // 模拟应用重启：同一个文件被新的 store 读回来
        let dir = temp_dir("reload");
        let path = dir.join(LEDGER_FILE_NAME);
        {
            let store = JobLedgerStore::load(path.clone());
            assert_eq!(store.allocate_job_num(), 1);
            assert_eq!(store.allocate_job_num(), 2);
            store.upsert(entry("job_2", JobStatus::Running, None));
        }
        let reopened = JobLedgerStore::load(path);
        assert_eq!(reopened.allocate_job_num(), 3);
        let jobs = reopened.entries();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].job_id, "job_2");
        assert_eq!(jobs[0].status, JobStatus::Running);
        assert_eq!(jobs[0].captured_bytes, 42);
        assert_eq!(jobs[0].owner_conversation_id.as_deref(), Some("conv_1"));
    }

    #[test]
    fn upsert_replaces_same_id_and_update_patches() {
        let dir = temp_dir("upsert");
        let store = JobLedgerStore::load(dir.join(LEDGER_FILE_NAME));
        store.upsert(entry("job_1", JobStatus::Running, None));
        store.update("job_1", |j| {
            j.status = JobStatus::Completed;
            j.finished_at_millis = Some(9);
        });
        let jobs = store.entries();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].status, JobStatus::Completed);
        assert_eq!(jobs[0].finished_at_millis, Some(9));
        // 不存在的 id：忽略，不新增
        store.update("job_x", |j| j.status = JobStatus::Killed);
        assert_eq!(store.entries().len(), 1);
    }

    #[test]
    fn prune_drops_expired_and_reports_their_spill_files() {
        let dir = temp_dir("prune");
        let store = JobLedgerStore::load(dir.join(LEDGER_FILE_NAME));
        let now = RETENTION_MILLIS * 10;
        store.upsert(entry(
            "job_old",
            JobStatus::Completed,
            Some(now - RETENTION_MILLIS - 1),
        ));
        store.upsert(entry("job_fresh", JobStatus::Completed, Some(now - 1000)));
        // 运行中的记录即使很旧也不删（可能是上次运行没结算的痕迹）
        let mut running = entry("job_running", JobStatus::Running, None);
        running.started_at_millis = 1;
        store.upsert(running);

        let dropped = store.prune(now);
        assert_eq!(dropped, vec!["/tmp/marcel-job-job_old.log".to_string()]);
        let ids: Vec<String> = store.entries().iter().map(|j| j.job_id.clone()).collect();
        assert_eq!(ids, vec!["job_fresh", "job_running"]);
    }

    #[test]
    fn prune_caps_entry_count_from_the_oldest_settled() {
        let dir = temp_dir("cap");
        let store = JobLedgerStore::load(dir.join(LEDGER_FILE_NAME));
        for i in 0..(MAX_LEDGER_JOBS + 5) {
            store.upsert(entry(
                &format!("job_{}", i),
                JobStatus::Completed,
                Some((i as u128) + 1),
            ));
        }
        let dropped = store.prune(RETENTION_MILLIS);
        assert_eq!(store.entries().len(), MAX_LEDGER_JOBS);
        assert_eq!(dropped.len(), 5, "只该丢掉最旧的 5 条");
        assert!(dropped[0].contains("job_0"), "{:?}", dropped);
    }

    #[test]
    fn corrupt_file_is_quarantined_and_not_deleted() {
        let dir = temp_dir("corrupt");
        let path = dir.join(LEDGER_FILE_NAME);
        std::fs::write(&path, "{ this is not json").unwrap();

        let store = JobLedgerStore::load(path.clone());
        // 原文件被挪走而不是删掉；内容原样保留
        assert!(!path.exists());
        let backup = dir.join(format!("{}.bak", LEDGER_FILE_NAME));
        assert_eq!(
            std::fs::read_to_string(&backup).unwrap(),
            "{ this is not json"
        );
        // 从空台账起步，功能不受影响
        assert_eq!(store.allocate_job_num(), 1);
        assert!(store.entries().is_empty());
    }

    #[test]
    fn unreadable_file_is_quarantined_before_being_overwritten() {
        // 读不动（权限 / Windows 共享冲突 / 非 UTF-8）不是「损坏」：原文件
        // 完全可能还有救，谁都不许把它盖掉。这里用非 UTF-8 内容稳定复现
        // 「读不动」这个分支（不依赖平台权限模型）。
        let dir = temp_dir("unreadable");
        let path = dir.join(LEDGER_FILE_NAME);
        let original: Vec<u8> = vec![0xff, 0xfe, 0x00, 0x01];
        std::fs::write(&path, &original).unwrap();

        let store = JobLedgerStore::load(path.clone());
        // 隔离：原内容一个字节都没丢
        let backup = dir.join(format!("{}.bak", LEDGER_FILE_NAME));
        assert_eq!(std::fs::read(&backup).unwrap(), original);
        // 从空台账起步，取号照常
        assert_eq!(store.allocate_job_num(), 1);
        // 写盘写的是新文件，不会把原内容盖掉（它已经在 .bak 里）
        assert!(path.exists());
        assert_ne!(std::fs::read(&path).unwrap(), original);
    }

    #[test]
    fn unquarantinable_file_is_never_overwritten() {
        // 连隔离都做不到时（文件被占用 / 目录不可写）：宁愿这次运行不落盘，
        // 也不能用 atomic_write 把原文件整份替换掉——那是数据销毁。
        // 这里让 `.bak` 被一个非空目录占住，稳定复现「改名失败」。
        let dir = temp_dir("sealed");
        let path = dir.join(LEDGER_FILE_NAME);
        let original: Vec<u8> = vec![0xff, 0x00, 0xfe];
        std::fs::write(&path, &original).unwrap();
        let backup = dir.join(format!("{}.bak", LEDGER_FILE_NAME));
        std::fs::create_dir(&backup).unwrap();
        std::fs::write(backup.join("keep.txt"), b"do not touch").unwrap();

        let store = JobLedgerStore::load(path.clone());
        assert_eq!(store.allocate_job_num(), 1);
        store.upsert(entry("job_1", JobStatus::Completed, Some(1)));
        // 取号与新记录都只活在内存里，盘上一个字节都没动
        assert_eq!(store.entries().len(), 1);
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(
            std::fs::read(backup.join("keep.txt")).unwrap(),
            b"do not touch".to_vec()
        );
    }

    #[test]
    fn captured_total_keeps_the_larger_fact() {
        // 溢出被上限截断 / 写入中途失败：文件长度小于台账里的计数，
        // 读路径必须按「抓到的更多」走，否则会把丢掉的输出说成没发生过。
        let mut ledger_entry = entry("job_truncated", JobStatus::Failed, Some(2));
        ledger_entry.captured_bytes = 8 * 1024 * 1024;
        assert_eq!(ledger_entry.captured_total(4096), 8 * 1024 * 1024);
        assert_eq!(
            ledger_entry.captured_total(8 * 1024 * 1024 + 7),
            8 * 1024 * 1024 + 7
        );
        // 崩溃时结算没跑（计数停在 0）：文件长度才是事实
        let mut crashed = entry("job_crashed", JobStatus::Running, None);
        crashed.captured_bytes = 0;
        assert_eq!(crashed.captured_total(123), 123);
        // to_info 与实际读到的输出量同源
        assert_eq!(crashed.to_info(123).total_output_bytes, 123);
        assert_eq!(
            ledger_entry.to_info(4096).total_output_bytes,
            8 * 1024 * 1024
        );
    }

    #[test]
    fn one_bad_job_entry_does_not_reset_the_watermark() {
        // 单条记录坏掉不该毁掉整份台账：水位归零会让旧 job_id 被重用
        // （模型历史里的 job_3 会指到另一个作业上），比丢一条记录严重得多。
        let dir = temp_dir("tolerant");
        let path = dir.join(LEDGER_FILE_NAME);
        std::fs::write(
            &path,
            r#"{
                "next_job_num": 7,
                "jobs": [
                    {"job_id": "job_1", "status": "completed", "captured_bytes": 5},
                    {"job_id": "job_2"},
                    {"status": "killed"},
                    {"job_id": "job_3", "status": "not-a-real-status"}
                ]
            }"#,
        )
        .unwrap();

        let store = JobLedgerStore::load(path.clone());
        // 水位不受影响：接着 7 往后数
        assert_eq!(store.allocate_job_num(), 8);
        let jobs = store.entries();
        let ids: Vec<&str> = jobs.iter().map(|j| j.job_id.as_str()).collect();
        // 缺 status 的按「结局未知」保留（绝不默认成 completed）；
        // 缺 job_id 的无法命名，丢弃；status 取值非法的丢弃。
        assert_eq!(ids, vec!["job_1", "job_2"]);
        assert_eq!(jobs[0].status, JobStatus::Completed);
        assert_eq!(jobs[0].captured_bytes, 5);
        assert_eq!(jobs[1].status, JobStatus::Interrupted);
        // 这不是「损坏」：原文件没被隔离，坏条目之后的保存是正常路径
        assert!(path.exists());
        assert!(!dir.join(format!("{}.bak", LEDGER_FILE_NAME)).exists());
    }

    #[test]
    fn jobs_field_of_the_wrong_type_still_reads_the_watermark() {
        // `jobs` 整个不是数组解释不出「哪条好」→ 按损坏处理（隔离 + 起步），
        // 但原文件必须留着，绝不静默丢。
        let dir = temp_dir("badjobs");
        let path = dir.join(LEDGER_FILE_NAME);
        std::fs::write(&path, r#"{"next_job_num": 3, "jobs": "oops"}"#).unwrap();
        let store = JobLedgerStore::load(path.clone());
        assert_eq!(store.allocate_job_num(), 1);
        assert!(store.entries().is_empty());
        assert!(dir.join(format!("{}.bak", LEDGER_FILE_NAME)).exists());
    }

    #[test]
    fn unknown_fields_and_missing_fields_do_not_reset() {
        let dir = temp_dir("compat");
        let path = dir.join(LEDGER_FILE_NAME);
        // 未来版本写的字段（未知字段）不该让水位归零
        std::fs::write(&path, r#"{"next_job_num": 9, "future_field": {"a": 1}}"#).unwrap();
        let store = JobLedgerStore::load(path.clone());
        assert_eq!(store.allocate_job_num(), 10);

        // 缺字段（旧版本写的 `{}`）按默认值读，同样不报错
        std::fs::write(&path, "{}").unwrap();
        let store = JobLedgerStore::load(path);
        assert_eq!(store.allocate_job_num(), 1);
        assert!(store.entries().is_empty());
    }

    #[test]
    fn entries_without_new_fields_load_as_running() {
        // 只有第一档字段的文件（没有 jobs）→ 空条目表，水位照用
        let dir = temp_dir("v1");
        let path = dir.join(LEDGER_FILE_NAME);
        std::fs::write(&path, r#"{"next_job_num": 4}"#).unwrap();
        let store = JobLedgerStore::load(path);
        assert_eq!(store.allocate_job_num(), 5);
        assert!(store.entries().is_empty());
    }
}
