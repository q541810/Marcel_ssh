//! 「owner → 子资源 id」记账：owner 终态时把名下的子资源整体取走并回收。
//!
//! 用在两处：多机操控自动拉起的会话（`AppState::multi_host_targets`）与 Agent
//! 传输（`AppState::agent_transfer_by_task`）。两处此前各写一遍同样的逻辑。
//!
//! ## 为什么不是「注册前查一次父状态就够」
//!
//! 注册发生在子任务里，清理发生在父任务终态时，两者之间必然有 await 点。清理是
//! 「把 owner 名下的集合整体取走」—— 它只认**取的那一刻表里有什么**。如果清理
//! 先跑、注册后到，这条子资源就再也没人清理：
//!
//! - 多机操控：自动拉起的 SSH 会话泄漏，挂到应用退出；
//! - Agent 传输：任务已经停止，传输却继续跑。
//!
//! 在注册前多查一次父状态只是把窗口变窄（查完到落表之间同样有 await 点），
//! 而且 `agent/transfer.rs` 那一路此前**根本没有这个检查**。
//!
//! ## 正确做法：让两件事不可能都漏过去
//!
//! 清理跑过要**留下痕迹**（[`ChildResources::take_all`] 打的收尾标记），而注册时
//! 「查痕迹 + 落表」在**同一次加锁**里完成，与清理的「取走 + 打标记」互斥。于是
//! 只有两种结局，都安全：
//!
//! | 谁先拿到锁 | 结果 |
//! |---|---|
//! | 注册 | 子资源在表里；随后清理必然取走它 |
//! | 清理 | 注册看到标记 → 返回 `false`，调用方当场回收刚建的子资源 |
//!
//! 所以 [`ChildResources::register`] 的返回值**不要忽略** —— `false` 意味着
//! 表里没有这一条，没人会替你清理。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use tokio::sync::RwLock as TokioRwLock;

#[derive(Default)]
struct Inner {
    by_owner: HashMap<String, HashSet<String>>,
    /// 已收尾的 owner 集合。**刻意不随 `by_owner` 一起删** —— 它就是这个类型的
    /// 全部意义：没有它，「清理已经跑过了」这件事就无从查起，窗口就回来了。
    ///
    /// 它的生命周期与 owner 本身一致，由 [`ChildResources::forget_owner`] 在
    /// owner **被彻底回收时**清掉 —— 注意不是「任务终态时」：调用点在
    /// `prune_terminal_tasks`（任务记录被剪掉，`max_terminal = 200` 之后每次终态
    /// 才真的剪）。所以这个集合的大小被剪枝窗口封顶（约 200 + 在跑任务数），
    /// 不是无界增长。
    closed: HashSet<String>,
}

/// owner → 子资源记账表。克隆共享同一张表。
#[derive(Clone, Default)]
pub struct ChildResources {
    inner: Arc<TokioRwLock<Inner>>,
}

impl ChildResources {
    pub fn new() -> Self {
        Self::default()
    }

    /// 把子资源挂到 owner 名下。
    ///
    /// 返回 `false` = **owner 已经收尾**（清理跑在了注册前面）：表里刻意没有落这
    /// 一条，调用方**必须当场回收刚创建的子资源**，否则它会成为无人清理的孤儿。
    ///
    /// 标了 `#[must_use]`：忽略这个返回值 = 把竞态防护变成一句空话（这正是这个
    /// 类型存在的理由）。但要知道它的边界 —— 它只拦「裸调用后丢弃」，
    /// `let _ = reg.register(..)` 是显式丢弃、不报警（rustc 实测）。真正的保证是
    /// 两处调用点都写成 `if !...register(..) { 当场回收 }`（`multi_host`、
    /// `sftp_transfer` 的上传/下载）。
    #[must_use = "false 表示 owner 已收尾、表里没落这一条，调用方必须当场回收子资源"]
    pub async fn register(&self, owner: &str, child: &str) -> bool {
        let mut inner = self.inner.write().await;
        if inner.closed.contains(owner) {
            return false;
        }
        inner
            .by_owner
            .entry(owner.to_string())
            .or_default()
            .insert(child.to_string());
        true
    }

    /// 取走 owner 名下的全部子资源并打上收尾标记。返回值由调用方负责回收。
    ///
    /// 对同一个 owner 重复调用是安全的（第二次返回空），且第一次之后就再也不会
    /// 有新的子资源挂进来。
    pub async fn take_all(&self, owner: &str) -> Vec<String> {
        let mut inner = self.inner.write().await;
        inner.closed.insert(owner.to_string());
        inner
            .by_owner
            .remove(owner)
            .map(|s| s.into_iter().collect())
            .unwrap_or_default()
    }

    /// 取走 owner 名下**不在 `keep` 里**的子资源，`keep` 里的留在表里。
    ///
    /// 与 [`Self::take_all`] 的关键差别：**不打收尾标记**。留下的那些之后还能
    /// 被清理取走（owner 还没收尾），也不会拒绝新的注册 —— 这正是「资源比
    /// owner 的终态活得更久」需要的语义（多机自动拉起的会话要给还在跑的
    /// 后台作业用：任务收尾时留下它们，末条作业结算时再取走）。
    ///
    /// `keep` 为空时等价于 `take_all`，但不会打标记——需要收尾语义的调用方
    /// 自己走 [`Self::take_all`]。
    pub async fn take_filtered(&self, owner: &str, keep: &HashSet<String>) -> Vec<String> {
        let mut inner = self.inner.write().await;
        let (taken, emptied) = match inner.by_owner.get_mut(owner) {
            Some(children) => {
                let taken: Vec<String> = children
                    .iter()
                    .filter(|child| !keep.contains(*child))
                    .cloned()
                    .collect();
                for child in &taken {
                    children.remove(child);
                }
                (taken, children.is_empty())
            }
            None => (Vec::new(), false),
        };
        // 表项摘空就一起回收（与 `remove_child` 同规矩：留着空集合会让
        // `by_owner` 随历史 owner 增长）。
        if emptied {
            inner.by_owner.remove(owner);
        }
        taken
    }

    /// 从**任意** owner 名下摘掉一个子资源（用户单独取消某条资源时用）。
    /// 只摘资源、**不碰收尾标记** —— owner 并没有终态，之后仍可继续注册。
    /// 返回是否找到（找不到是正常情况：它可能已经被父终态清理取走了）。
    pub async fn remove_child(&self, child: &str) -> bool {
        let mut inner = self.inner.write().await;
        let mut emptied: Vec<String> = Vec::new();
        let mut found = false;
        // 扫**全部** owner 而不是命中即返回：child id 目前唯一（每次调用新生成的
        // uuid），但旧实现就是全扫，收窄成「只摘第一个」没有任何好处，反而会让
        // 万一真出现重复挂载时留下永远取消不掉的残留。
        for (owner, children) in inner.by_owner.iter_mut() {
            if children.remove(child) {
                found = true;
                if children.is_empty() {
                    emptied.push(owner.clone());
                }
            }
        }
        for owner in emptied {
            inner.by_owner.remove(&owner);
        }
        found
    }

    /// owner 被彻底回收（如任务记录被剪掉）时清掉它的痕迹。
    ///
    /// **只在确认 owner 不会再出现时调用**：清掉标记之后，同一个 owner 又能重新
    /// 注册子资源了（id 复用会让新资源挂到旧 owner 的名下）。
    ///
    /// **返回值是被丢掉的子资源 id，正常情况下为空** —— 走到这里之前，该 owner 的
    /// 清理（[`Self::take_all`]）应当已经把表项取空了。非空意味着清理还没跑到
    /// （或跑了却没取到），那些子资源此刻**既不在表里、也不会再被回收**，调用方
    /// 必须处理（自己回收，或至少告警）。
    ///
    /// 之所以把这件事做成返回值而不是内部静默 `remove`：调用点（任务记录剪枝）
    /// 与清理是**两个独立的 fire-and-forget spawn**，tokio 不保证它们的先后 ——
    /// 静默删表项会让「会话没被断开 / 传输没被取消」变成完全无声的泄漏。
    pub async fn forget_owner(&self, owner: &str) -> Vec<String> {
        let mut inner = self.inner.write().await;
        inner.closed.remove(owner);
        inner
            .by_owner
            .remove(owner)
            .map(|s| s.into_iter().collect())
            .unwrap_or_default()
    }

    /// 当前在册的子资源数（诊断 / 测试用）。
    #[cfg(test)]
    pub(crate) async fn registered_count(&self, owner: &str) -> usize {
        self.inner
            .read()
            .await
            .by_owner
            .get(owner)
            .map_or(0, |s| s.len())
    }

    /// 这个 owner 名下此刻**还有没有表项**（测试钩子）。
    ///
    /// `registered_count` 分不出「没有表项」与「有个空集合」，所以「摘空之后要把
    /// owner 条目也回收」这条断言此前没有区分力（注入「不回收」照样绿）。表项留着
    /// 不回收会让 `by_owner` 随历史 owner 缓慢增长。
    #[cfg(test)]
    pub(crate) async fn has_owner(&self, owner: &str) -> bool {
        self.inner.read().await.by_owner.contains_key(owner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn take_all_drains_and_later_registration_is_refused() {
        let res = ChildResources::new();
        assert!(res.register("task-1", "sess-a").await);
        assert!(res.register("task-1", "sess-b").await);

        let mut taken = res.take_all("task-1").await;
        taken.sort();
        assert_eq!(taken, vec!["sess-a", "sess-b"]);

        // 清理跑过之后，晚到的注册必须被拒 —— 这正是竞态里的第二种结局。
        assert!(
            !res.register("task-1", "sess-c").await,
            "owner 已收尾，注册必须返回 false 让调用方自己回收"
        );
        assert_eq!(res.registered_count("task-1").await, 0);
    }

    #[tokio::test]
    async fn resources_registered_before_cleanup_are_always_taken() {
        // 竞态里的第一种结局：注册先到，清理必然取走它。
        let res = ChildResources::new();
        for id in ["sess-a", "sess-b", "sess-c"] {
            assert!(res.register("task-1", id).await);
        }
        assert_eq!(res.take_all("task-1").await.len(), 3);
        // 第二次取走为空，不会误伤
        assert!(res.take_all("task-1").await.is_empty());
    }

    #[tokio::test]
    async fn take_all_on_unknown_owner_still_closes_it() {
        // 父任务没有任何子资源就被终态化：也必须打标记，否则随后到达的注册会漏网。
        let res = ChildResources::new();
        assert!(res.take_all("task-1").await.is_empty());
        assert!(!res.register("task-1", "sess-late").await);
    }

    #[tokio::test]
    async fn owners_are_independent() {
        let res = ChildResources::new();
        assert!(res.register("task-1", "sess-a").await);
        assert!(res.register("task-2", "sess-b").await);

        assert_eq!(res.take_all("task-1").await, vec!["sess-a"]);
        // task-2 不受影响
        assert!(res.register("task-2", "sess-c").await);
        assert_eq!(res.take_all("task-2").await.len(), 2);
    }

    /// `take_filtered` 留下的子资源**仍在表里、仍能被后续清理取走** —— 这正是
    /// 「资源比 owner 的终态活得更久」（多机会话要给还在跑的后台作业用）所依赖
    /// 的不变量。若它顺手打了收尾标记，留下的那些就再也没人回收了。
    #[tokio::test]
    async fn take_filtered_keeps_the_kept_ones_reachable() {
        let res = ChildResources::new();
        for id in ["sess-busy", "sess-idle"] {
            assert!(res.register("task-1", id).await);
        }

        let keep: HashSet<String> = ["sess-busy".to_string()].into_iter().collect();
        assert_eq!(res.take_filtered("task-1", &keep).await, vec!["sess-idle"]);
        // 留下的还在表里（少一个才是漏，多一个才是错——按集合比）
        assert_eq!(res.registered_count("task-1").await, 1);
        // 收尾标记没被打：owner 之后仍可注册新资源（会话被再次拉起的情形）
        assert!(res.register("task-1", "sess-late").await);
        // 末条作业结算后的那次清理能把留下的都取走
        let mut taken = res.take_all("task-1").await;
        taken.sort();
        assert_eq!(taken, vec!["sess-busy", "sess-late"]);
        assert_eq!(res.registered_count("task-1").await, 0);
    }

    /// 摘空之后 owner 表项一起回收（与 `remove_child` 同规矩）。
    #[tokio::test]
    async fn take_filtered_clears_the_owner_entry_when_it_empties() {
        let res = ChildResources::new();
        assert!(res.register("task-1", "sess-a").await);
        assert_eq!(
            res.take_filtered("task-1", &HashSet::new()).await,
            vec!["sess-a"],
            "keep 空时应当把所有子资源都取走"
        );
        assert!(!res.has_owner("task-1").await, "摘空后表项必须回收");
        // 但收尾标记**没**被打：owner 照样能重新注册
        assert!(res.register("task-1", "sess-b").await);
        assert_eq!(res.take_all("task-1").await, vec!["sess-b"]);
    }

    #[tokio::test]
    async fn remove_child_detaches_one_resource_without_touching_the_marker() {
        let res = ChildResources::new();
        assert!(res.register("task-1", "sess-a").await);
        assert!(res.register("task-1", "sess-b").await);

        assert!(res.remove_child("sess-a").await);
        assert!(!res.remove_child("sess-a").await, "重复摘除应为 false");
        assert_eq!(res.registered_count("task-1").await, 1);

        // 摘单个资源 != owner 收尾：owner 之后仍可继续注册（标记没被动过）
        assert!(
            res.register("task-1", "sess-c").await,
            "remove_child 不该碰收尾标记"
        );
        assert_eq!(res.registered_count("task-1").await, 2);
        // 剩下的仍然会被清理取走
        let mut taken = res.take_all("task-1").await;
        taken.sort();
        assert_eq!(taken, vec!["sess-b", "sess-c"]);
    }

    #[tokio::test]
    async fn remove_child_clears_the_owner_entry_when_it_empties() {
        let res = ChildResources::new();
        assert!(res.register("task-1", "sess-only").await);
        assert!(res.remove_child("sess-only").await);

        assert_eq!(res.registered_count("task-1").await, 0);
        // 关键断言：**表项本身**也要回收。只看 registered_count 是不够的 —— 它对
        // 「没有表项」与「留着空集合」都返回 0，所以把回收那段删掉它也照样绿（实测）。
        assert!(
            !res.has_owner("task-1").await,
            "摘空之后 owner 表项必须一起回收，否则 by_owner 会随历史 owner 增长"
        );

        // 标记没被设：还能重新注册，且清理时取得到
        assert!(res.register("task-1", "sess-new").await);
        assert_eq!(res.take_all("task-1").await, vec!["sess-new"]);
    }

    /// 清理还没跑到时遗忘 owner：**不许静默删表项**。
    ///
    /// 这是真被复现过的交错：`finalize_task` 的清理与任务记录的剪枝是两次独立的
    /// fire-and-forget spawn，tokio 不保证先后。遗忘若把表项连同标记一起删掉，
    /// 晚到的 `take_all` 会拿到空集 —— 自动拉起的会话再也不会被断开。所以
    /// `forget_owner` 把丢掉的 id 交出来，让调用方（剪枝）能告警。
    #[tokio::test]
    async fn forget_owner_reports_leftovers_instead_of_dropping_them_silently() {
        let res = ChildResources::new();
        assert!(res.register("task-1", "sess-a").await);
        assert_eq!(
            res.forget_owner("task-1").await,
            vec!["sess-a"],
            "清理未完成时遗忘必须报出残留，不能静默丢弃"
        );

        // 正常顺序（先清理、后遗忘）应当没有残留
        assert!(res.register("task-1", "sess-b").await);
        assert_eq!(res.take_all("task-1").await, vec!["sess-b"]);
        assert!(res.forget_owner("task-1").await.is_empty());
    }

    /// 不变量：并发下每条子资源要么**被清理取走**，要么 **register 返回 `false`
    /// 让调用方自己回收** —— 不允许「既没被取走、register 还说成功了」。
    ///
    /// 这条只有「查标记 + 落表」在**同一次加锁**里才成立。把 register 拆成
    /// 「读锁检查 → 让出 → 写锁落表」后，前面的单测**全绿**（注入实测），只有
    /// 这条会红 —— 它守的是原子性本身。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn register_and_take_all_can_never_lose_a_child() {
        for round in 0..300 {
            let res = ChildResources::new();
            let owner = format!("task-{round}");
            let child = format!("sess-{round}");

            let writer = {
                let (res, owner, child) = (res.clone(), owner.clone(), child.clone());
                tokio::spawn(async move { res.register(&owner, &child).await })
            };
            let taker = {
                let (res, owner) = (res.clone(), owner.clone());
                tokio::spawn(async move { res.take_all(&owner).await })
            };

            let registered = writer.await.expect("register 任务不应 panic");
            let taken = taker.await.expect("take_all 任务不应 panic");
            assert!(
                !registered || taken.contains(&child),
                "第 {round} 轮：register 说成功、take_all 却没取到 —— {child} 既不在表里也没人回收"
            );
        }
    }

    #[tokio::test]
    async fn forget_owner_allows_reuse_after_the_owner_is_gone() {
        let res = ChildResources::new();
        assert!(res.register("task-1", "sess-a").await);
        res.take_all("task-1").await;
        assert!(!res.register("task-1", "sess-late").await);

        // 任务记录被剪掉之后，id 可以重新使用
        res.forget_owner("task-1").await;
        assert!(res.register("task-1", "sess-new").await);
    }
}
