//! 账本：同步引擎的**纯逻辑状态**（无网络、无异步）。
//!
//! 一台设备上同步需要记住的一切——镜像、基线、登记表、待上传队列、等待确认的删除、游标——
//! 以及围绕它们的同步操作（捕获本机改动、大量删除闸、吸收远端文件）。引擎（`engine.rs`）只负责
//! 把「网络 + 各配置的写者锁」编排起来，真正改状态的都是这里的方法，所以能直接单测。
//!
//! 约定：
//! - **本机 op 先合并进镜像**再谈别的（`capture_into`）：这样 `affected_vs_doc` 把文档对齐到镜像时，
//!   本机刚做的修改已经在镜像里，不会被旧值盖回去；
//! - **等待确认的删除（`held`）不进镜像**：没确认之前，快照里不能带上它，落地时也要把这些元素
//!   从待落地路径里摘出去，否则镜像里还活着的元素会被「落地」成本机文档里复活；
//! - 任何改动都只置脏标记，落盘由 `flush` 统一做，顺序是 outbox / held → 镜像 → 基线 → 状态
//!   （游标最后写：崩溃后宁可重读一遍，合并是幂等的）。

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::core::format::{SegmentFile, SnapshotFile, TierSwitches};
use super::core::{
    diff, export_all, flatten_scoped, DiffCtx, Hlc, HlcClock, IdMapRegistry, Mirror, Op, OpKind,
    Path, Platform, ScopeRules, Seg,
};
use super::store::{
    valid_source_key, Cursor, DeviceRecord, Dirty, LedgerFiles, LoadedLedger, PersistedState,
};
use super::types::HeldSummary;
use crate::error::AppError;

/// 一个列表里本轮被删掉的元素达到这个数，并且占到删除前元素数的一半以上，就算「大量删除」。
pub const MASS_DELETE_MIN: usize = 5;

/// 一次捕获的结果。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct CaptureStats {
    /// 并入镜像、进了待上传队列的 op 数。
    pub captured: usize,
    /// 因为是大量删除而扣下的 Tombstone 数。
    pub held: usize,
}

pub struct Ledger {
    pub st: PersistedState,
    pub mirrors: BTreeMap<String, Mirror>,
    pub baselines: BTreeMap<String, Value>,
    pub outbox: Vec<Op>,
    pub held: Vec<Op>,
    pub clock: HlcClock,
    pub dirty: Dirty,
    /// 版本刚升级后、还没做过第一次捕获的源：第一次捕获不发 Remove。
    pub suppress_pending: BTreeSet<String>,
}

impl Ledger {
    /// 全新的空账本（没开同步）。
    pub fn fresh() -> Self {
        Self::from_loaded(LoadedLedger::default())
    }

    pub fn from_loaded(loaded: LoadedLedger) -> Self {
        let clock = match (&loaded.state.hlc, loaded.state.device_id.is_empty()) {
            (Some(last), _) => HlcClock::from_last(last.clone()),
            (None, _) => HlcClock::new(loaded.state.device_id.clone()),
        };
        let mut ledger = Ledger {
            st: loaded.state,
            mirrors: loaded.mirrors,
            baselines: loaded.baselines,
            outbox: loaded.outbox,
            held: loaded.held,
            clock,
            dirty: Dirty::default(),
            suppress_pending: BTreeSet::new(),
        };
        ledger.migrate_key_references();
        ledger
    }

    /// 旧基线包含这些字段，但旧作用域从未上传它们。只补曾经保存过的引用，
    /// 用零时钟让云端后来的明确选择优先；之后仍按正常 baseline diff 捕获编辑。
    fn migrate_key_references(&mut self) {
        if self.st.key_references_shared {
            return;
        }
        if let Some(baseline) = self.baselines.get("connections") {
            let idmaps = self.st.idmaps.entry("connections".into()).or_default();
            let ops = super::core::export_all_at(
                "connections",
                baseline,
                &super::scopes::CONNECTIONS_RULES,
                Platform::current(),
                idmaps,
                &Hlc::zero_for(self.clock.device().to_string()),
            );
            let ops: Vec<_> = ops.into_iter().filter(|op| {
                matches!(op.path.last(), Some(Seg::Key(key)) if key == "keyId" || key == "jumpKeyId")
                    && matches!(&op.kind, OpKind::Set(Value::String(value)) if !value.is_empty())
            }).collect();
            if !ops.is_empty() {
                let mirror = self.mirrors.entry("connections".into()).or_default();
                for op in &ops {
                    mirror.merge(op);
                }
                self.outbox.extend(ops);
                self.dirty.outbox = true;
                self.dirty.mirrors.insert("connections".into());
                self.set_applied("connections", false);
            }
        }
        self.st.key_references_shared = true;
        self.dirty.state = true;
    }

    pub fn enabled(&self) -> bool {
        self.st.enabled
    }

    pub fn device_id(&self) -> &str {
        &self.st.device_id
    }

    /// 换一个新身份（创建 / 加入同步）：时钟从零开始。
    pub fn set_identity(&mut self, device_id: &str) {
        self.st.device_id = device_id.to_string();
        self.clock = HlcClock::new(device_id);
        self.dirty.state = true;
    }

    // ── 状态判断 ─────────────────────────────────────────────────────────

    /// 这个源是否有镜像里的东西还没落地到本机文档。
    pub fn needs_apply(&self, key: &str) -> bool {
        if self.st.needs_restore.get(key).copied().unwrap_or(false) {
            return true;
        }
        match self.st.applied_mirror.get(key) {
            Some(applied) => !applied,
            // 从没记过：镜像里有东西才需要落地（老版本不认识、新版本才认识的源）
            None => self.mirrors.get(key).is_some_and(|m| !m.is_empty()),
        }
    }

    pub fn is_restoring(&self, key: &str) -> bool {
        self.st.needs_restore.get(key).copied().unwrap_or(false)
    }

    pub fn set_applied(&mut self, key: &str, applied: bool) {
        if self.st.applied_mirror.get(key).copied() != Some(applied) {
            self.st.applied_mirror.insert(key.to_string(), applied);
            self.dirty.state = true;
        }
    }

    pub fn set_needs_restore(&mut self, key: &str, restore: bool) {
        let cur = self.st.needs_restore.get(key).copied().unwrap_or(false);
        if cur != restore {
            if restore {
                self.st.needs_restore.insert(key.to_string(), true);
            } else {
                self.st.needs_restore.remove(key);
            }
            self.dirty.state = true;
        }
    }

    pub fn set_baseline(&mut self, key: &str, doc: Value) {
        if self.baselines.get(key) != Some(&doc) {
            self.baselines.insert(key.to_string(), doc);
            self.dirty.baselines.insert(key.to_string());
        }
    }

    /// 等待确认的删除，按源汇总（给状态用）。只数被删的元素（Tombstone），不数随同扣下的顺序叶子。
    pub fn held_summary(&self) -> Vec<HeldSummary> {
        let mut by_source: BTreeMap<&str, usize> = BTreeMap::new();
        for op in self
            .held
            .iter()
            .filter(|o| matches!(o.kind, OpKind::Tombstone))
        {
            *by_source.entry(op.source.as_str()).or_default() += 1;
        }
        by_source
            .into_iter()
            .map(|(source, count)| HeldSummary {
                source: source.to_string(),
                count,
            })
            .collect()
    }

    /// 某个源里被扣下的元素路径（落地时要避开）。
    pub fn held_paths(&self, key: &str) -> Vec<Path> {
        self.held
            .iter()
            .filter(|o| o.source == key)
            .map(|o| o.path.clone())
            .collect()
    }

    // ── 捕获本机改动 ─────────────────────────────────────────────────────

    /// 对一个源做一次捕获：基线 → `current` 的差异变成 op，并入镜像与待上传队列，基线推进到 `current`。
    ///
    /// 基线缺失（这个源是新出现的）：镜像里已经有云端的东西 → 以 `Hlc::zero_for` 导出（云端赢）；
    /// 镜像是空的 → 按当前时钟全量导出。
    pub fn capture_into(
        &mut self,
        key: &str,
        rules: &ScopeRules,
        platform: Platform,
        wall_ms: u64,
        current: &Value,
    ) -> Result<CaptureStats, AppError> {
        if !valid_source_key(key) {
            return Err(AppError::Other(format!("非法的同步源名: {key}")));
        }
        let suppress = self.suppress_pending.remove(key);
        let mut ops: Vec<Op>;
        let baseline_for_gate: Value;

        match self.baselines.get(key).cloned() {
            Some(baseline) => {
                let idmaps = self.st.idmaps.entry(key.to_string()).or_default();
                let mut ctx = DiffCtx {
                    rules,
                    platform,
                    idmaps,
                    clock: &mut self.clock,
                    wall_ms,
                    suppress_removes: suppress,
                };
                ops = diff(key, &baseline, current, &mut ctx);
                baseline_for_gate = baseline;
            }
            None => {
                let mirror_has_data = self.mirrors.get(key).is_some_and(|m| !m.is_empty());
                let idmaps = self.st.idmaps.entry(key.to_string()).or_default();
                if mirror_has_data {
                    ops = super::core::export_all_at(
                        key,
                        current,
                        rules,
                        platform,
                        idmaps,
                        &Hlc::zero_for(self.clock.device().to_string()),
                    );
                } else {
                    let mut ctx = DiffCtx {
                        rules,
                        platform,
                        idmaps,
                        clock: &mut self.clock,
                        wall_ms,
                        suppress_removes: false,
                    };
                    ops = export_all(key, current, &mut ctx);
                }
                baseline_for_gate = Value::Null;
            }
        }
        self.dirty.state = true; // idmaps / 时钟可能变了

        let held_ops = self.split_mass_deletes(key, rules, platform, &baseline_for_gate, &mut ops);
        let stats = CaptureStats {
            captured: ops.len(),
            held: held_ops.len(),
        };

        if !ops.is_empty() {
            let mirror = self.mirrors.entry(key.to_string()).or_default();
            for op in &ops {
                mirror.merge(op);
            }
            self.dirty.mirrors.insert(key.to_string());
            self.outbox.extend(ops);
            self.dirty.outbox = true;
        }
        if !held_ops.is_empty() {
            self.held.extend(held_ops);
            self.dirty.held = true;
        }
        self.set_baseline(key, current.clone());
        Ok(stats)
    }

    /// 大量删除闸：同一个列表里这一批的 Tombstone ≥ [`MASS_DELETE_MIN`] 且 ≥ 删除前元素数的一半，
    /// 这批 Tombstone 从 `ops` 里摘出来返回（其余 op 照常放行）。
    fn split_mass_deletes(
        &mut self,
        key: &str,
        rules: &ScopeRules,
        platform: Platform,
        baseline: &Value,
        ops: &mut Vec<Op>,
    ) -> Vec<Op> {
        // 按列表分组
        let mut by_list: BTreeMap<Path, usize> = BTreeMap::new();
        for op in ops.iter() {
            if matches!(op.kind, OpKind::Tombstone) {
                if let Some((_, list)) = op.path.split_last() {
                    *by_list.entry(list.to_vec()).or_default() += 1;
                }
            }
        }
        by_list.retain(|_, n| *n >= MASS_DELETE_MIN);
        if by_list.is_empty() {
            return Vec::new();
        }

        let mut reg = self.st.idmaps.get(key).cloned().unwrap_or_default();
        let flat = flatten_scoped(baseline, rules, platform, &mut reg);
        let mut held_lists: BTreeSet<Path> = BTreeSet::new();
        for (list, count) in &by_list {
            let mut elements: BTreeSet<&[Seg]> = BTreeSet::new();
            for p in flat.keys() {
                if p.len() > list.len() && p.starts_with(list) && p[list.len()].is_id() {
                    elements.insert(&p[..=list.len()]);
                }
            }
            if count * 2 >= elements.len() {
                held_lists.insert(list.clone());
            }
        }
        if held_lists.is_empty() {
            return Vec::new();
        }
        // 同一个列表的顺序叶子一并扣下：它记着「删除之后剩下谁」，单独放出去会让别的设备看到
        // 一个缺了这些元素的顺序，而撤销删除时这些元素也回不到原来的位置。
        let (held, pass): (Vec<Op>, Vec<Op>) = std::mem::take(ops).into_iter().partition(|op| {
            let Some((last, list)) = op.path.split_last() else {
                return false;
            };
            match op.kind {
                OpKind::Tombstone => held_lists.contains(list),
                OpKind::Set(_) => last.is_order() && held_lists.contains(list),
                OpKind::Remove => false,
            }
        });
        *ops = pass;
        held
    }

    /// 放行等待确认的删除：并入镜像、进待上传队列。返回放行了多少条。
    pub fn release_held(&mut self) -> usize {
        let held = std::mem::take(&mut self.held);
        let n = held.len();
        for op in held {
            self.mirrors
                .entry(op.source.clone())
                .or_default()
                .merge(&op);
            self.dirty.mirrors.insert(op.source.clone());
            self.outbox.push(op);
        }
        self.dirty.held = true;
        self.dirty.outbox = true;
        n
    }

    /// 撤销等待确认的删除：丢掉这些 op，并标记涉及的源「镜像要重新落地」，让下一轮把被删的元素写回本机。
    pub fn discard_held(&mut self) -> usize {
        let held = std::mem::take(&mut self.held);
        let n = held.len();
        let sources: BTreeSet<String> = held.into_iter().map(|o| o.source).collect();
        for s in sources {
            self.set_applied(&s, false);
        }
        self.dirty.held = true;
        n
    }

    // ── 吸收远端文件 ─────────────────────────────────────────────────────

    fn touch_device(
        &mut self,
        device_id: &str,
        info: &super::core::DeviceInfo,
        tiers: Option<TierSwitches>,
        newest_ms: Option<u64>,
        now_rfc3339: impl Fn(u64) -> String,
    ) {
        let rec = self.st.devices.entry(device_id.to_string()).or_default();
        rec.name = info.name.clone();
        rec.platform = info.platform.clone();
        rec.app_version = info.app_version.clone();
        // 文件头没写 tiers = 老版本，只有配置档。**不要**因为一个老文件就把已知的新信息抹掉：
        // 只在新文件明确带了 tiers 时才覆盖（同一台设备升级后会补上）。
        if let Some(t) = tiers {
            rec.tiers = t;
        }
        if let Some(ms) = newest_ms.filter(|ms| *ms > 0) {
            rec.last_seen_at = Some(now_rfc3339(ms));
        }
        self.dirty.state = true;
    }

    /// 吸收一个增量段。返回镜像发生变化的源。
    pub fn ingest_segment(
        &mut self,
        file: &SegmentFile,
        wall_ms: u64,
        rfc3339: impl Fn(u64) -> String,
    ) -> BTreeSet<String> {
        let newest = file
            .ops
            .iter()
            .filter(|o| o.hlc.device == file.device.id)
            .map(|o| o.hlc.ms)
            .max();
        self.touch_device(&file.device.id, &file.device, file.tiers, newest, rfc3339);

        let mut changed = BTreeSet::new();
        for op in &file.ops {
            if !valid_source_key(&op.source) {
                continue; // 来路不明的源名不敢拿去拼文件名
            }
            let idmaps = self.st.idmaps.entry(op.source.clone()).or_default();
            idmaps.learn_path(&op.path);
            self.clock.observe(&op.hlc, wall_ms);
            let mirror = self.mirrors.entry(op.source.clone()).or_default();
            if mirror.merge(op) {
                changed.insert(op.source.clone());
            }
        }
        self.after_ingest(&changed);
        changed
    }

    /// 吸收一个快照。返回镜像发生变化的源。
    pub fn ingest_snapshot(
        &mut self,
        file: &SnapshotFile,
        wall_ms: u64,
        rfc3339: impl Fn(u64) -> String,
    ) -> BTreeSet<String> {
        let newest = file
            .mirrors
            .values()
            .flat_map(|m| {
                m.leaves()
                    .map(|(_, e)| &e.hlc)
                    .chain(m.tombstones().map(|(_, h)| h))
            })
            .filter(|h| h.device == file.device.id)
            .map(|h| h.ms)
            .max();
        self.touch_device(&file.device.id, &file.device, file.tiers, newest, rfc3339);

        let mut changed = BTreeSet::new();
        for (source, remote) in &file.mirrors {
            if !valid_source_key(source) {
                continue;
            }
            let idmaps = self.st.idmaps.entry(source.clone()).or_default();
            if let Some(remote_maps) = file.idmaps.get(source) {
                idmaps.merge_from(remote_maps);
            }
            remote.learn_into(idmaps);
            if let Some(h) = remote.max_hlc() {
                self.clock.observe(&h, wall_ms);
            }
            let mirror = self.mirrors.entry(source.clone()).or_default();
            if mirror.merge_mirror(remote) {
                changed.insert(source.clone());
            }
        }
        self.after_ingest(&changed);
        changed
    }

    fn after_ingest(&mut self, changed: &BTreeSet<String>) {
        for source in changed {
            self.dirty.mirrors.insert(source.clone());
            self.set_applied(source, false);
        }
        self.dirty.state = true;
    }

    pub fn cursor(&self, device: &str) -> Cursor {
        self.st.cursors.get(device).cloned().unwrap_or_default()
    }

    pub fn set_cursor(&mut self, device: &str, cursor: Cursor) {
        if self.st.cursors.get(device) != Some(&cursor) {
            self.st.cursors.insert(device.to_string(), cursor);
            self.dirty.state = true;
        }
    }

    // ── 落盘 ─────────────────────────────────────────────────────────────

    /// 把脏的部分写盘。写失败返回错误，但**脏标记保留**（下次再试）。
    pub fn flush(&mut self, files: &LedgerFiles) -> Result<(), AppError> {
        if self.dirty.outbox {
            files.save_outbox(&self.outbox)?;
            self.dirty.outbox = false;
        }
        if self.dirty.held {
            files.save_held(&self.held)?;
            self.dirty.held = false;
        }
        let mirrors: Vec<String> = self.dirty.mirrors.iter().cloned().collect();
        for key in mirrors {
            if let Some(m) = self.mirrors.get(&key) {
                files.save_mirror(&key, m)?;
            }
            self.dirty.mirrors.remove(&key);
        }
        let baselines: Vec<String> = self.dirty.baselines.iter().cloned().collect();
        for key in baselines {
            if let Some(b) = self.baselines.get(&key) {
                files.save_baseline(&key, b)?;
            }
            self.dirty.baselines.remove(&key);
        }
        // 状态最后写：游标不能跑在镜像前面
        if self.dirty.state {
            self.st.hlc = Some(self.clock.last().clone());
            files.save_state(&self.st)?;
            self.dirty.state = false;
        }
        Ok(())
    }

    /// 把所有东西标脏（创建 / 加入完成后整套写一遍）。
    pub fn mark_all_dirty(&mut self) {
        self.dirty.state = true;
        self.dirty.outbox = true;
        self.dirty.held = true;
        self.dirty.mirrors = self.mirrors.keys().cloned().collect();
        self.dirty.baselines = self.baselines.keys().cloned().collect();
    }

    /// 全部镜像 / 登记表的快照（写 snap 文件用）。
    pub fn snapshot_parts(&self) -> (BTreeMap<String, Mirror>, BTreeMap<String, IdMapRegistry>) {
        (self.mirrors.clone(), self.st.idmaps.clone())
    }

    pub fn device_records(&self) -> &BTreeMap<String, DeviceRecord> {
        &self.st.devices
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::scopes::CONNECTIONS_RULES;
    use serde_json::json;

    fn ledger(device: &str) -> Ledger {
        let mut l = Ledger::fresh();
        l.set_identity(device);
        l.st.enabled = true;
        l
    }

    fn conns(n: usize) -> Value {
        json!({"connections": (0..n).map(|i| json!({"id": format!("c{i}"), "name": format!("n{i}")})).collect::<Vec<_>>()})
    }

    fn cap(l: &mut Ledger, doc: &Value, wall: u64) -> CaptureStats {
        l.capture_into(
            "connections",
            &CONNECTIONS_RULES,
            Platform::Desktop,
            wall,
            doc,
        )
        .unwrap()
    }

    #[test]
    fn old_key_references_are_exported_once_without_overwriting_cloud_choices() {
        let doc = json!({"connections": [{"id": "c0", "keyId": "local-key", "jumpKeyId": "jump-key", "keyPath": "/local/private", "name": "server"}]});
        let mut cloud = ledger("cloud");
        let mut cloud_doc = doc.clone();
        cloud_doc["connections"][0]["keyId"] = json!("new-cloud-key");
        cap(&mut cloud, &cloud_doc, 1000);
        let loaded = LoadedLedger {
            state: PersistedState {
                device_id: "old-device".into(),
                ..Default::default()
            },
            baselines: BTreeMap::from([("connections".into(), doc.clone())]),
            mirrors: cloud.mirrors,
            ..Default::default()
        };
        let mut migrated = Ledger::from_loaded(loaded);
        assert_eq!(migrated.outbox.len(), 2);
        assert!(migrated.outbox.iter().all(|op| op.hlc.ms == 0));
        let key_path = vec![Seg::key("connections"), Seg::id("c0"), Seg::key("keyId")];
        assert_eq!(
            migrated.mirrors["connections"].visible()[&key_path],
            json!("new-cloud-key")
        );
        assert_eq!(cap(&mut migrated, &doc, 2000).captured, 0);
        let restored = Ledger::from_loaded(LoadedLedger {
            state: migrated.st,
            baselines: migrated.baselines,
            mirrors: migrated.mirrors,
            outbox: migrated.outbox,
            ..Default::default()
        });
        assert_eq!(restored.outbox.len(), 2, "重启不重复迁移");
        assert!(!restored.dirty.state);
    }

    #[test]
    fn first_capture_exports_everything_then_only_real_changes() {
        let mut l = ledger("A");
        let doc = conns(2);
        let s = cap(&mut l, &doc, 1000);
        assert!(s.captured > 0 && s.held == 0);
        assert_eq!(l.baselines["connections"], doc);
        let queued = l.outbox.len();

        // 没改 = 没有新 op
        assert_eq!(cap(&mut l, &doc, 2000), CaptureStats::default());
        assert_eq!(l.outbox.len(), queued);

        // 改一个名字 = 一个 op，并且已并入本机镜像
        let mut doc2 = doc.clone();
        doc2["connections"][0]["name"] = json!("renamed");
        assert_eq!(cap(&mut l, &doc2, 3000).captured, 1);
        let visible = l.mirrors["connections"].visible();
        assert!(
            visible.values().any(|v| v == &json!("renamed")),
            "本机 op 先合并进镜像"
        );
    }

    #[test]
    fn mass_delete_is_held_and_not_merged_or_queued() {
        let mut l = ledger("A");
        cap(&mut l, &conns(10), 1000);
        l.outbox.clear();

        // 删掉 6 个（≥5 且 ≥ 一半）
        let stats = cap(&mut l, &conns(4), 2000);
        assert_eq!(stats.held, 7, "6 个 Tombstone + 同一个列表的顺序叶子");
        assert_eq!(stats.captured, 0);
        assert!(l.outbox.is_empty(), "不上传");
        assert_eq!(l.held.len(), 7);
        // 镜像里它们仍然活着（没合并 Tombstone）
        assert_eq!(l.mirrors["connections"].tombstone_count(), 0);
        assert_eq!(
            l.held_summary(),
            vec![HeldSummary {
                source: "connections".into(),
                count: 6
            }]
        );
        // 基线已经推进：下一次捕获不会再把同一批删除重新发现一遍
        assert_eq!(cap(&mut l, &conns(4), 3000), CaptureStats::default());
        assert_eq!(l.held.len(), 7);
    }

    #[test]
    fn small_or_proportionally_small_deletes_pass_through() {
        // 删 4 个：不到 5
        let mut l = ledger("A");
        cap(&mut l, &conns(10), 1000);
        l.outbox.clear();
        let s = cap(&mut l, &conns(6), 2000);
        assert_eq!(
            (s.held, s.captured),
            (0, 5),
            "4 个 Tombstone + 新的顺序叶子"
        );
        assert_eq!(l.mirrors["connections"].tombstone_count(), 4);

        // 删 5 个但列表有 20 个：不到一半
        let mut l = ledger("A");
        cap(&mut l, &conns(20), 1000);
        let s = cap(&mut l, &conns(15), 2000);
        assert_eq!(s.held, 0);
        assert_eq!(l.mirrors["connections"].tombstone_count(), 5);
    }

    #[test]
    fn release_merges_and_queues_while_discard_forces_a_reapply() {
        let mut l = ledger("A");
        cap(&mut l, &conns(10), 1000);
        l.outbox.clear();
        cap(&mut l, &conns(2), 2000);
        assert_eq!(l.held.len(), 9, "8 个 Tombstone + 顺序叶子");

        let mut l2 = Ledger::from_loaded(LoadedLedger {
            state: l.st.clone(),
            mirrors: l.mirrors.clone(),
            baselines: l.baselines.clone(),
            outbox: l.outbox.clone(),
            held: l.held.clone(),
        });
        assert_eq!(l.release_held(), 9);
        assert!(l.held.is_empty());
        assert_eq!(l.outbox.len(), 9);
        assert_eq!(l.mirrors["connections"].tombstone_count(), 8);

        l2.set_applied("connections", true);
        assert_eq!(l2.discard_held(), 9);
        assert!(l2.held.is_empty() && l2.outbox.is_empty());
        assert!(
            l2.needs_apply("connections"),
            "撤销后要让下一轮把被删的元素写回本机"
        );
    }

    #[test]
    fn upgrade_suppresses_removes_on_the_first_capture_only() {
        let mut l = ledger("A");
        let mut doc = json!({"keep": 1, "legacy": 2});
        // 用一个没有任何作用域规则的空规则集
        let rules = &crate::sync::core::ScopeRules::SHARED_ALL;
        l.capture_into("settings", rules, Platform::Desktop, 1000, &doc)
            .unwrap();
        l.outbox.clear();

        l.suppress_pending.insert("settings".into());
        doc.as_object_mut().unwrap().remove("legacy");
        let s = l
            .capture_into("settings", rules, Platform::Desktop, 2000, &doc)
            .unwrap();
        assert_eq!(
            s.captured, 0,
            "升级后第一次捕获：新版本删掉的字段不发 Remove"
        );
        assert!(l.suppress_pending.is_empty());

        // 之后的删除照常上报
        doc.as_object_mut().unwrap().remove("keep");
        let s = l
            .capture_into("settings", rules, Platform::Desktop, 3000, &doc)
            .unwrap();
        assert_eq!(s.captured, 1);
    }

    #[test]
    fn missing_baseline_with_cloud_data_exports_at_zero_so_the_cloud_wins() {
        let mut l = ledger("B");
        // 镜像里已有云端的数据
        let mut cloud = Mirror::new();
        cloud.merge(&Op {
            source: "settings".into(),
            path: vec![Seg::key("a")],
            kind: OpKind::Set(json!("cloud")),
            hlc: Hlc {
                ms: 5,
                counter: 0,
                device: "A".into(),
            },
        });
        l.mirrors.insert("settings".into(), cloud);
        let rules = &crate::sync::core::ScopeRules::SHARED_ALL;
        l.capture_into(
            "settings",
            rules,
            Platform::Desktop,
            9999,
            &json!({"a": "local", "b": 1}),
        )
        .unwrap();
        let vis = l.mirrors["settings"].visible();
        assert_eq!(vis[&vec![Seg::key("a")]], json!("cloud"), "云端赢");
        assert_eq!(vis[&vec![Seg::key("b")]], json!(1), "本机独有的保留");
    }

    #[test]
    fn needs_apply_logic() {
        let mut l = ledger("A");
        assert!(!l.needs_apply("settings"), "没有镜像：无事可做");
        let mut m = Mirror::new();
        m.merge(&Op {
            source: "settings".into(),
            path: vec![Seg::key("a")],
            kind: OpKind::Set(json!(1)),
            hlc: Hlc {
                ms: 1,
                counter: 0,
                device: "X".into(),
            },
        });
        l.mirrors.insert("settings".into(), m);
        assert!(l.needs_apply("settings"), "镜像里有、从没落地过");
        l.set_applied("settings", true);
        assert!(!l.needs_apply("settings"));
        l.set_needs_restore("settings", true);
        assert!(l.needs_apply("settings") && l.is_restoring("settings"));
        l.set_needs_restore("settings", false);
        assert!(!l.needs_apply("settings"));
    }

    #[test]
    fn flush_writes_only_dirty_parts_and_state_last() {
        let tmp = tempfile::tempdir().unwrap();
        let files = LedgerFiles::new(tmp.path());
        let mut l = ledger("A");
        cap(&mut l, &conns(2), 1000);
        l.flush(&files).unwrap();
        let back = files.load();
        assert_eq!(back.baselines["connections"], conns(2));
        assert!(!back.mirrors["connections"].is_empty());
        assert!(!back.outbox.is_empty());
        assert_eq!(back.state.device_id, "A");
        assert!(back.state.hlc.is_some(), "时钟随状态落盘");

        // 没有新改动 = 不写（删掉文件后 flush 不会把它重新写出来）
        std::fs::remove_file(files.dir().join("outbox.json")).unwrap();
        l.flush(&files).unwrap();
        assert!(!files.dir().join("outbox.json").exists());
    }
}
