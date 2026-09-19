//! 取消信号注册表 —— 「id → 取消信号」这套容器在 AppState 里被抄了 4 遍。
//!
//! Agent 任务 / SFTP 上传 / SFTP 下载 / 插件安装各有一张取消表，四处的类型
//! **逐字相同**（`Arc<PlRwLock<HashMap<String, watch::Sender<bool>>>>`），
//! 「注册 → 建 Drop guard → 取消时 remove + send」这套动作也各抄一遍，连 Drop
//! guard 都有两份逐字相同的实现（`TransferCancelGuard` / `InstallCancelGuard`，
//! 后者注释里还写着「参照前者」）。改一次取消语义（加取消原因、加超时、加级联）
//! 就要同时改四处，漏一处就是某一路取消静默失效。
//!
//! 这个模块**只统一容器**，不碰各自的业务状态机：四者的语义差别很大（任务终态、
//! 传输清理 `.part`/sidecar、插件安装回滚），强行合并会造出假抽象。
//!
//! 两条不变量：
//!
//! 1. **注销必然发生**：`Registration` 在 Drop 时把自己从表里摘掉（且只摘自己
//!    那一次注册 —— 见表里序号字段的注释），所以不存在「任务早就结束了，表里还
//!    留着 sender」的泄漏。
//! 2. **表里存的是这个 id 唯一的 sender**：调用方注册后不需要再持有发送端，
//!    所以 `cancel` 一 remove，对应任务的 `changed()` 必然立刻有结果 ——
//!    这也是 cancel 语义能被单测断言的前提。

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::RwLock as PlRwLock;
use tokio::sync::watch;

/// 取消信号表：id → 取消信号发送端。克隆共享同一张表。
#[derive(Clone, Default)]
pub struct CancellationRegistry {
    inner: Arc<PlRwLock<RegistryInner>>,
}

#[derive(Default)]
struct RegistryInner {
    /// id → (注册序号, 取消发送端)。序号让 `Registration` 的 Drop 只注销**自己
    /// 那一次**注册：同一个 id 被重复注册时（重试、前端重发、任务重建），先来的
    /// guard 绝不能把后来那条从表里摘掉 —— 那会让后来那个任务变得不可取消，而且
    /// 它的接收端会立刻看到通道关闭，调用方普遍把「通道关闭」当成「已被取消」，
    /// 于是任务无声地自己中止。
    senders: HashMap<String, (u64, watch::Sender<bool>)>,
    next_seq: u64,
}

impl CancellationRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册一个取消通道，返回持有接收端、并在 Drop 时自动注销的凭据。
    ///
    /// `Registration` 标了 `#[must_use]`：**别把它扔掉**。guard 一 Drop 就注销，
    /// 表里唯一的 sender 随之消失，接收端的 `changed()` 会立刻返回（`Err`）——
    /// 而调用方的写法普遍是 `_ = cancel_rx.changed() => 已取消`，于是任务会
    /// 瞬间"自己被取消"且看不出原因。
    ///
    /// 注意 `#[must_use]` 只拦「裸调用后丢弃」这一种写法：`let _ = reg.register(..)`
    /// 是**显式**丢弃，rustc 一声不吭（实测过），而它同样是立刻 Drop。别把这条
    /// 属性当成完整保证 —— 真正的保证是调用点写对了（`manager.rs` 把它 move 进
    /// spawn 的 future，扫描各 sfcp/plugin 站点用命名绑定 `_cancel_registration`）。
    #[must_use = "Registration 一旦被丢弃就会立刻注销，取消信号随之失效"]
    pub fn register(&self, id: &str) -> Registration {
        let (tx, rx) = watch::channel(false);
        let seq = {
            let mut inner = self.inner.write();
            let seq = inner.next_seq;
            inner.next_seq = inner.next_seq.wrapping_add(1);
            inner.senders.insert(id.to_string(), (seq, tx));
            seq
        };
        Registration {
            id: id.to_string(),
            seq,
            registry: self.clone(),
            rx,
        }
    }

    /// 取消并注销。返回「确实取消了一个在册目标」。
    ///
    /// 不在册时返回 `false`（任务已结束、或已被取消过）—— 与旧写法
    /// `if let Some(sender) = map.write().remove(id) { sender.send(true) }` 等价，
    /// 但把「取消了一个不存在的目标」这件事变成了可断言的返回值。
    pub fn cancel(&self, id: &str) -> bool {
        match self.inner.write().senders.remove(id) {
            Some((_, tx)) => {
                let _ = tx.send(true);
                true
            }
            None => false,
        }
    }

    /// 仅当表里那条记录仍是 `seq` 这一次注册时才注销（guard 的 Drop 专用）。
    ///
    /// 刻意**不发**取消信号：guard 结束只说明「这个使用者不再关心了」（正常收尾），
    /// 与「用户点了取消」是两件事，混为一谈会让收尾动作被当成用户操作。
    fn unregister_if(&self, id: &str, seq: u64) -> bool {
        let mut inner = self.inner.write();
        if inner.senders.get(id).is_some_and(|(s, _)| *s == seq) {
            inner.senders.remove(id);
            true
        } else {
            false
        }
    }
}

/// 一次注册的凭据：Drop 时从表里注销。
///
/// 取接收端只能通过 `receiver()`，而它 clone 出去的是**独立句柄**：rx 可以活得比
/// 凭据久。所以「注册还在不在」与「手里这个 rx 还能不能等到信号」是两件事 ——
/// 凭据一旦提前 Drop，rx 会立刻看到通道关闭（`changed()` 返回 `Err`），而调用方
/// 普遍把 `Err` 当成「已被取消」（见 `llm/manager.rs` 的取消臂），任务会无声地
/// 自己中止。这就是标 `#[must_use]` 的原因，也是 Agent 任务必须把凭据 move 进
/// `tokio::spawn` 的 future 的原因。
pub struct Registration {
    id: String,
    seq: u64,
    registry: CancellationRegistry,
    rx: watch::Receiver<bool>,
}

impl Registration {
    /// 取消接收端。`watch::Receiver` 是共享句柄，clone 廉价；
    /// 照旧用法 `let mut cancel_rx = reg.receiver();` 即可。
    pub fn receiver(&self) -> watch::Receiver<bool> {
        self.rx.clone()
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.registry.unregister_if(&self.id, self.seq);
    }
}

impl CancellationRegistry {
    /// 表里此刻是否登记着这个 id（测试钩子）。
    ///
    /// 存在的唯一理由是让「Drop 有没有把表项摘掉」**可观测**：不经过 `cancel` 的
    /// 纯 Drop 路径此前只被一条「Drop 后接收端看到通道关闭」间接守着，而那条在实现
    /// 变坏时是**挂死**（`changed()` 永不等不到结果）而不是干净变红 —— 没有超时的
    /// `cargo test` 会一直挂着。而「Drop 必须注销」是生产不变量：漏了它取消表会随
    /// 任务数永久泄漏，且已结束的任务仍会被 `cancel` 命中。
    #[cfg(test)]
    pub(crate) fn is_registered(&self, id: &str) -> bool {
        self.inner.read().senders.contains_key(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancel_signals_the_receiver_and_unregisters() {
        let reg = CancellationRegistry::new();
        let registration = reg.register("t1");
        let mut rx = registration.receiver();

        assert!(reg.cancel("t1"), "在册目标应被取消");
        rx.changed().await.expect("sender 在 send 后才被丢弃");
        assert!(*rx.borrow(), "取消信号应已置位");

        // 已经注销：重复取消不再命中（旧实现靠 remove 返回 None 隐式表达这一点）
        assert!(!reg.cancel("t1"), "已注销的目标不应再次命中");
    }

    #[tokio::test]
    async fn cancel_on_unknown_id_is_false_not_panic() {
        let reg = CancellationRegistry::new();
        assert!(!reg.cancel("never-registered"));
    }

    /// **不经过 `cancel`** 的纯 Drop 路径必须注销。
    ///
    /// 上一版这条测试先调了 `reg.cancel("t1")` —— 那已经把它摘掉了，所以把
    /// `impl Drop` 改成空实现它照样绿（实测），等于这条生产不变量零覆盖。现在直接
    /// 看表里有没有这个 id。
    #[tokio::test]
    async fn guard_drop_unregisters_the_entry_without_going_through_cancel() {
        let reg = CancellationRegistry::new();
        let registration = reg.register("t1");
        assert!(reg.is_registered("t1"), "注册后应在表里");

        drop(registration); // 只 Drop，不 cancel

        assert!(
            !reg.is_registered("t1"),
            "guard Drop 必须把表项摘掉：漏了它取消表会随任务数永久泄漏，             且已结束的任务仍会被 cancel 命中"
        );
    }

    /// 已注销之后再 Drop 一次也不能 panic（幂等）。
    #[tokio::test]
    async fn cancel_then_drop_is_idempotent() {
        let reg = CancellationRegistry::new();
        {
            let registration = reg.register("t1");
            assert!(reg.cancel("t1"));
            drop(registration);
        }
        assert!(!reg.is_registered("t1"));
    }

    #[tokio::test]
    async fn guard_drop_unregisters_without_signalling_cancellation() {
        let reg = CancellationRegistry::new();
        let registration = reg.register("t1");
        let rx = registration.receiver();

        drop(registration);
        // 注销 ≠ 取消：接收端的值仍是初始的 false（任务是自己正常结束的，
        // 不能让它看起来像被用户取消）。
        assert!(!*rx.borrow(), "guard 结束不应置位取消信号");
    }

    /// 同一个 id 被重复注册时，先来的 guard 结束**不能**把后来那条摘掉。
    #[tokio::test]
    async fn a_stale_registration_does_not_evict_the_newer_one() {
        let reg = CancellationRegistry::new();
        let first = reg.register("t1");
        let second = reg.register("t1");
        drop(first); // 先来的那次注册结束

        assert!(reg.cancel("t1"), "后来那次注册必须还在表里");
        let mut rx = second.receiver();
        rx.changed().await.expect("后来注册的接收端应收到取消");
        assert!(*rx.borrow());
    }

    #[tokio::test]
    async fn dropping_the_registration_closes_the_receiver() {
        // 这是 `#[must_use]` 想拦住的场景的可观测后果：guard 一丢，表里唯一的
        // sender 消失，`changed()` 立刻返回 —— 调用方普遍把 Err 也当"已取消"，
        // 于是任务会瞬间自己取消。测试把这条语义钉住，避免有人"顺手"改成
        // 不删表项的实现。
        let reg = CancellationRegistry::new();
        let registration = reg.register("t1");
        let mut rx = registration.receiver();
        drop(registration);
        // 必须带超时：实现变坏（表项没被摘、sender 还活着）时 `changed()` 会永远
        // 等不到结果，而没有超时的 `cargo test` 只会**挂死**而不是干净变红。
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), rx.changed()).await;
        assert!(
            matches!(outcome, Ok(Err(_))),
            "guard Drop 后接收端应立刻看到通道关闭，实际：{outcome:?}"
        );
    }

    #[tokio::test]
    async fn registration_moved_into_a_task_survives_the_spawner_returning() {
        // 钉住的是这条**模式**：注册凭据必须被 spawned future 捕获，留在外面的话
        // 建它的函数一返回就 Drop —— 表里唯一的 sender 消失，而调用方普遍把
        // 「通道关闭」当取消（`llm/manager.rs` 的 `select!` 里 `rx.changed()` 的
        // Err 同样命中取消分支），任务会在开跑前把自己取消掉。
        //
        // 边界：这里用的是**本测试自己定义的局部 `spawner`**，不触生产
        // `agent/manager.rs` 的 spawn —— 把那边的捕获去掉，这条照样绿。它守的是
        // 类型层面（凭据 owned、能被 move 进 `'static` future，改写成借用会编译
        // 不过），不是生产调用点。
        let reg = CancellationRegistry::new();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();

        fn spawner(
            reg: &CancellationRegistry,
            started: tokio::sync::oneshot::Sender<()>,
            release: tokio::sync::oneshot::Receiver<()>,
        ) {
            let registration = reg.register("t1");
            tokio::spawn(async move {
                let _registration = registration;
                let _ = started.send(());
                let _ = release.await;
            });
        } // ← 这里返回：guard 不该跟着死

        spawner(&reg, started_tx, release_rx);
        started_rx.await.expect("任务应已启动");
        assert!(
            reg.cancel("t1"),
            "spawner 已返回但任务仍在跑，注册必须还在表里"
        );
        drop(release_tx);
    }

    #[tokio::test]
    async fn clones_share_one_table() {
        let reg = CancellationRegistry::new();
        let other = reg.clone();
        let registration = reg.register("t1");
        let mut rx = registration.receiver();

        assert!(other.cancel("t1"), "克隆视图应看到同一张表");
        rx.changed().await.expect("应收到取消信号");
        assert!(*rx.borrow());
    }
}
