//! 配置流（一期）的驱动：把原先写在 `engine.rs` 里的那套「JSON 叶子镜像」搬到这里。
//!
//! **行为、文件名、AAD 一律逐字节不变**——一期已经部署在老用户机器上，改任何一处都会让他们
//! 读不懂新文件（或新版本读不懂老文件）。
//!
//! 驱动借用 [`Ledger`]：配置流的序号 / 游标 / 镜像 / 基线 / 待上传队列都还在一期账本里
//! （`PersistedState` 顶层字段），不搬家——搬了只会让一期账本与测试一起变形。
//!
//! 引擎在每一轮里依次调用下面的阶段方法（捕获 / 上传 / 拉取 / 落地 / 压缩）。阶段之间会释放
//! 借用、去处理别的流，所以状态都放在账本里，驱动本身不攒东西。

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use zeroize::Zeroizing;

use super::super::backends::Backend;
use super::super::core::crypto::DataKey;
use super::super::core::format::{
    self, decode_snapshot_plain, snapshot_plain, DeviceInfo, SegmentFile, SnapshotFile,
    TierSwitches,
};
use super::super::core::path::{split_platform_prefix, PrefixKind};
use super::super::core::FileKind;
use super::super::core::{
    affected_vs_doc, apply_to_doc, export_all_at, flatten_scoped, Hlc, Op, OpKind, Path, Seg,
};
use super::super::docedit;
use super::super::engine::{plain_error, rfc3339_from_ms, ApplyMode, SharedView, SyncDeps};
use super::super::history::{change_records, source_label, ChangeCtx, HistoryRecord};
use super::super::join::{reconcile_connections, remap_connection_refs};
use super::super::ledger::Ledger;
use super::super::sources::{AdapterUpdate, GuardWarning, SourceAdapter};
use super::super::store::{Cursor, LedgerFiles, StreamName, StreamState};
use super::{
    StreamApplied, StreamDriver, StreamFileKind, StreamRemote, StreamSnapshot, StreamSnapshotLayout,
};
use crate::config::keychain::SecretSlot;
use crate::error::AppError;

/// 一个增量段最多装多少条 op（超过的拆成多个段，免得单个文件大到传不动）。与一期相同。
pub const MAX_OPS_PER_SEGMENT: usize = 4000;

/// 一次拉取的结果。
#[derive(Default)]
pub struct PullReport {
    pub needs_upgrade: bool,
    pub soft_errors: Vec<String>,
}

pub enum PullError {
    /// 网络 / 认证 / 权限：整轮失败，退避重试。
    Hard(AppError),
    /// 这台设备有本版本读不懂的新格式数据。
    TooNew,
    /// 这台设备的某个文件坏了（解不开 / 结构不对）：记下来，不耽误其它设备。
    Soft(String),
}

/// 配置流的驱动。见模块文档。
pub struct ConfigStreamDriver<'a> {
    ledger: &'a mut Ledger,
    deps: &'a SyncDeps,
    view: &'a SharedView,
    join_remap: &'a mut BTreeMap<String, String>,
    files: LedgerFiles,
    /// 数据密钥。捕获阶段不需要它（密钥链坏了也要能把本机改动记下来），
    /// 上传 / 拉取 / 压缩时才要求有。
    dk: Option<DataKey>,
}

impl<'a> ConfigStreamDriver<'a> {
    pub fn new(
        ledger: &'a mut Ledger,
        deps: &'a SyncDeps,
        view: &'a SharedView,
        join_remap: &'a mut BTreeMap<String, String>,
        files: LedgerFiles,
        dk: Option<DataKey>,
    ) -> Self {
        Self {
            ledger,
            deps,
            view,
            join_remap,
            files,
            dk,
        }
    }

    fn device_info(&self) -> DeviceInfo {
        DeviceInfo {
            id: self.ledger.st.device_id.clone(),
            name: self.ledger.st.device_name.clone(),
            platform: self.deps.platform.as_str().to_string(),
            app_version: self.deps.app_version.clone(),
        }
    }

    fn tiers(&self) -> TierSwitches {
        self.ledger.st.tiers
    }

    fn now_ms(&self) -> u64 {
        (self.deps.now_ms)()
    }

    pub fn flush(&mut self) -> Result<(), AppError> {
        self.ledger.flush(&self.files)
    }

    // ═══════════════════════════════════════════════════════════════════
    // 捕获
    // ═══════════════════════════════════════════════════════════════════

    /// 对每个源捕获一次本机改动（一期 `capture_all`）。
    pub async fn capture_all(&mut self) -> Result<(), AppError> {
        let wall = self.now_ms();
        let platform = self.deps.platform;
        let adapters = self.deps.adapters.clone();
        for adapter in &adapters {
            let key = adapter.key();
            if self.ledger.is_restoring(key) {
                continue; // 等恢复落地，不能把「全变成默认值」推出去
            }
            let doc = adapter.read_json().await?;
            self.ledger
                .capture_into(key, adapter.rules(), platform, wall, &doc)?;
        }
        // 每个源都至少捕获过一次（恢复中的源会被镜像整份覆盖，不需要再抑制）：升级抑制到此为止
        self.ledger.suppress_pending.clear();
        if self.ledger.st.last_app_version != self.deps.app_version {
            self.ledger.st.last_app_version = self.deps.app_version.clone();
            self.ledger.dirty.state = true;
        }
        Ok(())
    }

    /// 捕获阶段：捕获本机改动并落盘。
    pub async fn phase_capture(&mut self) -> Result<(), AppError> {
        self.capture_all().await?;
        self.flush()
    }

    pub fn has_pending(&self) -> bool {
        !self.ledger.outbox.is_empty()
    }

    // ═══════════════════════════════════════════════════════════════════
    // 上传
    // ═══════════════════════════════════════════════════════════════════

    /// 把待上传队列写成增量段（一期 `upload_outbox`）：4000 op / 段、序号先落盘再 put、
    /// put 成功后才从队列里摘掉。
    pub async fn upload_outbox(&mut self, backend: &Arc<dyn Backend>) -> Result<(), AppError> {
        while !self.ledger.outbox.is_empty() {
            let n = self.ledger.outbox.len().min(MAX_OPS_PER_SEGMENT);
            let batch: Vec<Op> = self.ledger.outbox[..n].to_vec();
            // 序号先预留并落盘：put 成功但随后记账失败时，重传用的是新序号，
            // 读的一方不会因为「这个序号我读过了」漏掉重传里多出来的 op。序号允许有空洞。
            self.ledger.st.seq += 1;
            let seq = self.ledger.st.seq;
            self.ledger.dirty.state = true;
            self.flush()?;
            let plain = format::segment_plain(&self.device_info(), seq, &batch, self.tiers())?;
            let bytes = self.seal_plain(StreamFileKind::Segment, seq, None, &plain)?;
            let path = format::file_path(&self.ledger.st.device_id, FileKind::Segment, seq);
            backend.put(&path, &bytes).await.map_err(storage_err)?;
            self.ledger.outbox.drain(..n);
            self.ledger.dirty.outbox = true;
            self.ledger.st.segs_since_snapshot += 1;
            self.ledger.dirty.state = true;
            self.flush()?;
        }
        Ok(())
    }

    /// 配置流的封包：AAD 用一期的 `seg` / `snap`。
    fn seal_plain(
        &self,
        kind: StreamFileKind,
        seq: u64,
        part: Option<u32>,
        plain: &[u8],
    ) -> Result<Vec<u8>, AppError> {
        let tag = super::aad_tag_for(StreamName::Config, kind);
        let device = &self.ledger.st.device_id;
        let dk = self.dk.as_ref().ok_or_else(missing_data_key)?;
        let bytes = match (kind, part) {
            (StreamFileKind::SnapshotPart, Some(p)) => {
                format::seal_json_part(dk, tag, device, seq, p, plain)?
            }
            _ => format::seal_json(dk, tag, device, seq, plain)?,
        };
        Ok(bytes)
    }

    // ═══════════════════════════════════════════════════════════════════
    // 拉取
    // ═══════════════════════════════════════════════════════════════════

    pub async fn pull(&mut self, backend: &Arc<dyn Backend>) -> Result<PullReport, AppError> {
        let mut report = PullReport::default();
        let entries = backend
            .list(format::DEVICES_DIR)
            .await
            .map_err(storage_err)?;
        let mut devices: Vec<String> = entries
            .into_iter()
            .filter(|e| {
                e.is_dir
                    && format::is_valid_device_id(&e.name)
                    && e.name != self.ledger.st.device_id
            })
            .map(|e| e.name)
            .collect();
        devices.sort();
        for device in devices {
            match self.pull_device(backend, &device).await {
                Ok(()) => {}
                Err(PullError::Hard(e)) => {
                    // 已读到的部分先落盘（镜像先于游标），下一轮接着来
                    let _ = self.flush();
                    return Err(e);
                }
                Err(PullError::TooNew) => report.needs_upgrade = true,
                Err(PullError::Soft(msg)) => report.soft_errors.push(msg),
            }
        }
        self.flush()?;
        Ok(report)
    }

    fn classify(&self, device: &str, e: format::FormatError) -> PullError {
        if e.is_too_new() {
            return PullError::TooNew;
        }
        let name = self
            .ledger
            .st
            .devices
            .get(device)
            .map(|d| d.name.clone())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "另一台设备".to_string());
        PullError::Soft(format!("读取「{name}」的同步数据失败：{e}"))
    }

    async fn pull_device(
        &mut self,
        backend: &Arc<dyn Backend>,
        device: &str,
    ) -> Result<(), PullError> {
        let files = backend
            .list(&format::device_dir(device))
            .await
            .map_err(|e| PullError::Hard(storage_err(e)))?;
        let mut snaps: Vec<u64> = Vec::new();
        let mut segs: Vec<u64> = Vec::new();
        // 只处理文件：子目录（conv / sec / blob）对配置流只是老版本不认识的目录项，安静跳过。
        for f in files.iter().filter(|f| !f.is_dir) {
            match format::parse_file_name(&f.name) {
                Some((FileKind::Snapshot, seq)) => snaps.push(seq),
                Some((FileKind::Segment, seq)) => segs.push(seq),
                None => {}
            }
        }
        snaps.sort_unstable();
        segs.sort_unstable();

        let mut cursor = self.ledger.cursor(device);
        let wall = self.now_ms();

        // 有比游标新的快照：先读最新那个（整份镜像合并），再读其后的增量段
        if let Some(&latest) = snaps.last() {
            if latest > cursor.seg {
                let path = format::file_path(device, FileKind::Snapshot, latest);
                let Some(bytes) = backend
                    .get(&path)
                    .await
                    .map_err(|e| PullError::Hard(storage_err(e)))?
                else {
                    return Ok(()); // 列出来又读不到（对方正在压缩）：下一轮重新列
                };
                let dk = self
                    .dk
                    .as_ref()
                    .ok_or_else(|| PullError::Hard(missing_data_key()))?;
                let snap = format::decode_snapshot(dk, device, latest, &bytes)
                    .map_err(|e| self.classify(device, e))?;
                self.ledger.ingest_snapshot(&snap, wall, rfc3339_from_ms);
                cursor = Cursor {
                    snap: latest,
                    seg: latest,
                };
                self.ledger.set_cursor(device, cursor.clone());
            }
        }

        for seq in segs {
            if seq <= cursor.seg {
                continue;
            }
            let path = format::file_path(device, FileKind::Segment, seq);
            let Some(bytes) = backend
                .get(&path)
                .await
                .map_err(|e| PullError::Hard(storage_err(e)))?
            else {
                return Ok(());
            };
            let dk = self
                .dk
                .as_ref()
                .ok_or_else(|| PullError::Hard(missing_data_key()))?;
            let seg = format::decode_segment(dk, device, seq, &bytes)
                .map_err(|e| self.classify(device, e))?;
            self.ledger.ingest_segment(&seg, wall, rfc3339_from_ms);
            cursor.seg = seq;
            self.ledger.set_cursor(device, cursor.clone());
        }
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // 落地
    // ═══════════════════════════════════════════════════════════════════

    /// 对所有需要落地的源落地。返回各源的错误文案（落地失败不影响别的源）。
    pub async fn apply_pending(&mut self) -> Vec<String> {
        let mut errors = Vec::new();
        let adapters = self.deps.adapters.clone();
        for adapter in adapters {
            let key = adapter.key();
            if !self.ledger.needs_apply(key) {
                continue;
            }
            let mode = if self.ledger.is_restoring(key) {
                ApplyMode::Restore
            } else {
                ApplyMode::Normal
            };
            if let Err(e) = self.merge_into_doc(&adapter, mode).await {
                log::warn!(
                    "同步：{} 落地失败（下一轮重试）: {}",
                    source_label(key),
                    plain_error(&e)
                );
                errors.push(format!("{}：{}", source_label(key), plain_error(&e)));
            }
        }
        errors
    }

    /// 在一个源的写者锁内：（常规模式）先捕获本机改动 → 把文档对齐到镜像 → 提交 → 基线 = 提交后的序列化。
    pub async fn merge_into_doc(
        &mut self,
        adapter: &Arc<dyn SourceAdapter>,
        mode: ApplyMode,
    ) -> Result<bool, AppError> {
        let key = adapter.key();
        let rules = adapter.rules();
        let platform = self.deps.platform;
        let wall = self.now_ms();
        let zero = Hlc::zero_for(self.ledger.device_id().to_string());
        let remap = if mode == ApplyMode::Join {
            self.join_remap.clone()
        } else {
            BTreeMap::new()
        };

        #[derive(Default)]
        struct Scratch {
            dedupe: Vec<(String, String)>,
            warnings: Vec<GuardWarning>,
            /// 加入同步时本机引用改写的落点（sync 路径 → 改写后的值）。落地之后要再确认一次。
            ref_fixes: Vec<(Path, Value)>,
        }
        let mut scratch = Scratch::default();

        let update: AdapterUpdate = {
            let ledger = &mut *self.ledger;
            let scratch = &mut scratch;
            let adapter_ref = adapter.clone();
            adapter
                .update(Box::new(move |current: &Value| {
                    let mut doc = current.clone();
                    match mode {
                        ApplyMode::Normal => {
                            // 防抖窗口里的本机改动：落地之前先捕获，否则会被镜像里的旧值盖回去
                            ledger.capture_into(key, rules, platform, wall, current)?;
                        }
                        ApplyMode::Restore => {}
                        ApplyMode::Join => {
                            if key == "connections" {
                                let visible = ledger
                                    .mirrors
                                    .get(key)
                                    .map(|m| m.visible())
                                    .unwrap_or_default();
                                scratch.dedupe = reconcile_connections(&mut doc, &visible);
                            }
                            if !remap.is_empty() {
                                remap_connection_refs(key, &mut doc, &remap);
                                // 记下改写后的值：下面 ZERO 导出的本机数据对上云端的同名字段时会输给
                                // 云端（云端赢），落地后要把这些引用改回来，否则留下指向已删连接的悬空引用
                                scratch.ref_fixes = ref_targets(key, &doc, rules, platform, ledger);
                            }
                            // 本机已有数据以 ZERO 并入镜像：云端在任何冲突上都赢，本机独有的保留，
                            // 并且要上传（别的设备也该有这些）
                            let idmaps = ledger.st.idmaps.entry(key.to_string()).or_default();
                            let ops = export_all_at(key, &doc, rules, platform, idmaps, &zero);
                            if !ops.is_empty() {
                                let mirror = ledger.mirrors.entry(key.to_string()).or_default();
                                for op in &ops {
                                    mirror.merge(op);
                                }
                                ledger.dirty.mirrors.insert(key.to_string());
                                ledger.outbox.extend(ops);
                                ledger.dirty.outbox = true;
                            }
                        }
                    }

                    let mirror = ledger.mirrors.get(key).cloned().unwrap_or_default();
                    let mut affected = {
                        let idmaps = ledger.st.idmaps.entry(key.to_string()).or_default();
                        affected_vs_doc(&doc, &mirror, rules, platform, idmaps)
                    };
                    ledger.dirty.state = true;

                    // 扣下的大量删除：这些元素在镜像里还活着，但本机已经删了，别把它们写回来
                    let held = ledger.held_paths(key);
                    if !held.is_empty() {
                        affected.retain(|p| !held.iter().any(|h| p.starts_with(h)));
                    }
                    // 来源特有的安全过滤（known_hosts 的指纹冲突）
                    scratch.warnings =
                        adapter_ref.guard_affected(&doc, &mirror.visible(), &mut affected);

                    let mut new_doc = if affected.is_empty() {
                        doc.clone()
                    } else {
                        apply_to_doc(&doc, &mirror, &affected, rules, platform)
                    };
                    // 加入同步：让改写过的引用在落地之后仍然成立。上面按 ZERO 导出的本机数据遇到
                    // 「云端也有这个字段」会输给云端（云端赢），一条指向已被去重掉的连接的引用就被
                    // 云端的旧值盖回去了（典型：云端的多机清单是空的）。悬空引用是错的，所以这里把
                    // 它按当前时钟写回来——这是本机的修正，不是要让云端旧值赢。
                    if mode == ApplyMode::Join && !scratch.ref_fixes.is_empty() {
                        let mut ops = Vec::new();
                        for (path, value) in &scratch.ref_fixes {
                            let dpath = match split_platform_prefix(path, platform) {
                                (PrefixKind::Other, _) => continue,
                                (_, rest) => rest.to_vec(),
                            };
                            if docedit::get_leaf(&new_doc, &dpath) == Some(value) {
                                continue;
                            }
                            docedit::set_leaf(&mut new_doc, &dpath, value.clone());
                            let hlc = ledger.clock.now(wall);
                            ops.push(Op {
                                source: key.to_string(),
                                path: path.clone(),
                                kind: OpKind::Set(value.clone()),
                                hlc,
                            });
                        }
                        if !ops.is_empty() {
                            let mirror = ledger.mirrors.entry(key.to_string()).or_default();
                            for op in &ops {
                                mirror.merge(op);
                            }
                            ledger.dirty.mirrors.insert(key.to_string());
                            ledger.outbox.extend(ops);
                            ledger.dirty.outbox = true;
                        }
                    }
                    if new_doc == *current {
                        Ok(None)
                    } else {
                        Ok(Some(new_doc))
                    }
                }))
                .await?
        };

        let AdapterUpdate {
            committed,
            json,
            before,
        } = update;

        // 提交成功（或确认无需改动）才推进基线与落地标记
        self.ledger.set_baseline(key, json.clone());
        self.ledger.set_applied(key, true);
        self.ledger.set_needs_restore(key, false);
        self.ledger.dirty.mirrors.insert(key.to_string());

        let mut records: Vec<HistoryRecord> = Vec::new();
        let at = rfc3339_from_ms(self.now_ms());
        if committed {
            let idmaps = self.ledger.st.idmaps.get(key).cloned().unwrap_or_default();
            let mirror = self.ledger.mirrors.get(key).cloned().unwrap_or_default();
            let ctx = ChangeCtx {
                source: key,
                rules,
                platform,
                idmaps: &idmaps,
                mirror: &mirror,
                devices: self.ledger.device_records(),
                self_device_id: self.ledger.device_id(),
                at: &at,
            };
            let changes = change_records(&ctx, &before, &json);
            if mode == ApplyMode::Join {
                if !changes.is_empty() {
                    records.push(HistoryRecord::summary(
                        key,
                        &at,
                        "云端",
                        &format!(
                            "加入同步：把云端的 {} 处{}合并到了本机",
                            changes.len(),
                            source_label(key)
                        ),
                    ));
                }
            } else {
                records.extend(changes);
            }
        }
        for w in &scratch.warnings {
            records.push(HistoryRecord::warning(
                key,
                &at,
                "云端",
                &w.path,
                &w.text,
                &w.dedupe_key,
            ));
        }
        if !records.is_empty() {
            self.view.history.lock().push_many(records);
        }

        // 加入同步的连接去重：被丢掉的本机连接的密码 / 口令搬到云端那条名下。
        // **必须在 `after_apply` 之前**：`ConnectionsPostApply` 会把从文档里消失的连接
        // 在密钥链里的凭据一并删掉（同 `config_delete_connection`），搬晚了就什么都搬不着了。
        if !scratch.dedupe.is_empty() {
            for (local_id, cloud_id) in &scratch.dedupe {
                migrate_connection_secrets(self.deps.secrets.as_ref(), local_id, cloud_id);
                self.join_remap.insert(local_id.clone(), cloud_id.clone());
            }
        }

        if committed {
            adapter.after_apply(&before, &json).await;
            self.deps.events.data_applied(key);
        }
        Ok(committed)
    }

    // ═══════════════════════════════════════════════════════════════════
    // 压缩
    // ═══════════════════════════════════════════════════════════════════

    /// 本机增量段攒到 50 个就写一个快照、清理旧文件（只删自己的）。失败只记日志，不影响这一轮。
    pub async fn maybe_compact(&mut self, backend: &Arc<dyn Backend>) -> Result<(), AppError> {
        if self.ledger.st.segs_since_snapshot < super::super::engine::COMPACT_AFTER_SEGS
            || !self.ledger.outbox.is_empty()
        {
            return Ok(());
        }
        let seq = self.ledger.st.seq;
        let device = self.ledger.st.device_id.clone();
        let (mirrors, idmaps) = self.ledger.snapshot_parts();
        let plain = snapshot_plain(&self.device_info(), seq, &mirrors, &idmaps, self.tiers())?;
        let bytes = self.seal_plain(StreamFileKind::Snapshot, seq, None, &plain)?;
        backend
            .put(&format::file_path(&device, FileKind::Snapshot, seq), &bytes)
            .await
            .map_err(storage_err)?;
        self.ledger.st.segs_since_snapshot = 0;
        self.ledger.dirty.state = true;
        self.flush()?;

        // 清理：本机 ≤ seq 的增量段，以及更早的快照（只留最新两个）。别人的文件永远不动。
        let own = backend
            .list(&format::device_dir(&device))
            .await
            .map_err(storage_err)?;
        let mut snaps: Vec<u64> = Vec::new();
        let mut stale: Vec<String> = Vec::new();
        for f in own.iter().filter(|f| !f.is_dir) {
            match format::parse_file_name(&f.name) {
                Some((FileKind::Segment, s)) if s <= seq => {
                    stale.push(format::file_path(&device, FileKind::Segment, s))
                }
                Some((FileKind::Snapshot, s)) => snaps.push(s),
                _ => {}
            }
        }
        snaps.sort_unstable();
        if snaps.len() > 2 {
            for s in &snaps[..snaps.len() - 2] {
                stale.push(format::file_path(&device, FileKind::Snapshot, *s));
            }
        }
        for path in stale {
            backend.delete(&path).await.map_err(storage_err)?;
        }
        Ok(())
    }
}

/// 数据密钥丢了（系统密钥链被清理）：文案与一期一致，告诉用户怎么恢复。
fn missing_data_key() -> AppError {
    AppError::Other(
        "找不到同步的加密密钥（可能被系统清理了）。请先停止同步，再用恢复密钥重新加入。".into(),
    )
}

/// `storage::StorageError` → `AppError`（文案是给人看的中文整句）。
pub(crate) fn storage_err(e: super::super::storage::StorageError) -> AppError {
    AppError::from(e)
}

/// 把本机连接 `from` 的密码 / 私钥口令 / 跳板机凭据搬到 `to` 名下（`to` 已经有的不覆盖），再清掉 `from`。
pub fn migrate_connection_secrets(
    secrets: &dyn super::super::secrets::SyncSecretStore,
    from: &str,
    to: &str,
) {
    for (old, new) in SecretSlot::for_connection(from)
        .into_iter()
        .zip(SecretSlot::for_connection(to))
    {
        let moved = (|| -> Result<(), AppError> {
            if let Some(value) = secrets.get(&old)?.map(Zeroizing::new) {
                if secrets.get(&new)?.is_none() {
                    secrets.set(&new, &value)?;
                }
                secrets.delete(&old)?;
            }
            Ok(())
        })();
        if let Err(e) = moved {
            log::warn!("同步：迁移重复连接的{}失败: {}", old.describe(), e);
        }
    }
}

/// 加入同步时记下「本机文档里指向连接 id 的引用」当前的值（sync 路径 → 值）。
///
/// 只取受 `remap_connection_refs` 影响的那几处（快捷指令的 `sessionKey`、设置里的多机清单），
/// 用同一个扁平化把路径算出来，落地之后照这份清单把值写回去。
pub fn ref_targets(
    key: &str,
    doc: &Value,
    rules: &super::super::core::ScopeRules,
    platform: super::super::core::Platform,
    ledger: &Ledger,
) -> Vec<(Path, Value)> {
    let mut reg = ledger.st.idmaps.get(key).cloned().unwrap_or_default();
    let flat = flatten_scoped(doc, rules, platform, &mut reg);
    flat.into_iter()
        .filter(|(path, _)| match key {
            "quickCommands" => {
                matches!(path.as_slice(), [Seg::Key(list), Seg::Id { .. }, Seg::Key(f)]
                    if list == "commands" && f == "sessionKey")
            }
            "settings" => path
                .last()
                .is_some_and(|s| matches!(s, Seg::Key(k) if k == "multiHostConnectionIds")),
            _ => false,
        })
        .collect()
}

#[async_trait]
impl<'a> StreamDriver for ConfigStreamDriver<'a> {
    fn name(&self) -> StreamName {
        StreamName::Config
    }

    fn state(&self) -> StreamState {
        self.ledger.st.stream(StreamName::Config)
    }

    fn set_state(&mut self, s: StreamState) {
        self.ledger.st.set_stream(StreamName::Config, s);
        self.ledger.dirty.state = true;
    }

    fn snapshot_layout(&self) -> StreamSnapshotLayout {
        StreamSnapshotLayout::SingleFile
    }

    async fn capture(&mut self) -> Result<Vec<Vec<u8>>, AppError> {
        self.capture_all().await?;
        // 配置流的段在 `upload_outbox` 里按段落盘 + 封包（要边传边摘队列），这里不预生成明文。
        Ok(Vec::new())
    }

    async fn ack_capture(&mut self) -> Result<(), AppError> {
        // `upload_outbox` 自己按段摘队列；配置流没有额外的「ack」要做。
        Ok(())
    }

    /// 配置档恒为开，没有「首次开启」这回事；等价于一次普通捕获。
    async fn export_full(&mut self) -> Result<Vec<Vec<u8>>, AppError> {
        self.capture_all().await?;
        Ok(Vec::new())
    }

    /// 配置流的段已由引擎解密、核对过身份（设备 id / seq 与文件位置一致）。
    async fn apply_segment(&mut self, plain: &[u8]) -> Result<StreamApplied, AppError> {
        let file: SegmentFile = serde_json::from_slice(plain)
            .map_err(|e| AppError::Other(format!("同步数据无法解析：{e}")))?;
        let changed = self
            .ledger
            .ingest_segment(&file, self.now_ms(), rfc3339_from_ms);
        Ok(StreamApplied {
            changed: !changed.is_empty(),
            ..Default::default()
        })
    }

    /// 配置流的远端快照：单文件、整份镜像合并。
    async fn apply_snapshot(
        &mut self,
        remote: &dyn StreamRemote,
        index_seq: u64,
    ) -> Result<StreamApplied, AppError> {
        let path =
            format::stream_snapshot_path(remote.peer(), format::RemoteStream::Config, index_seq);
        let Some(bytes) = remote.get(&path).await? else {
            // 列出来又读不到（对方正在压缩）：下一轮重新列
            return Ok(StreamApplied::default());
        };
        let plain = remote.open(StreamFileKind::Snapshot, index_seq, None, &bytes)?;
        let snap: SnapshotFile = decode_snapshot_plain(remote.peer(), index_seq, &plain)?;
        let changed = self
            .ledger
            .ingest_snapshot(&snap, self.now_ms(), rfc3339_from_ms);
        Ok(StreamApplied {
            changed: !changed.is_empty(),
            ..Default::default()
        })
    }

    async fn land(&mut self) -> Result<StreamApplied, AppError> {
        let errors = self.apply_pending().await;
        if errors.is_empty() {
            Ok(StreamApplied {
                changed: true,
                ..Default::default()
            })
        } else {
            Err(AppError::Other(errors.join("；")))
        }
    }

    async fn make_snapshot(&mut self) -> Result<Option<StreamSnapshot>, AppError> {
        if self.ledger.st.segs_since_snapshot < super::super::engine::COMPACT_AFTER_SEGS
            || !self.ledger.outbox.is_empty()
        {
            return Ok(None);
        }
        let seq = self.ledger.st.seq;
        let (mirrors, idmaps) = self.ledger.snapshot_parts();
        let plain = snapshot_plain(&self.device_info(), seq, &mirrors, &idmaps, self.tiers())?;
        let mut files = BTreeMap::new();
        files.insert(format::file_name(FileKind::Snapshot, seq), plain);
        Ok(Some(StreamSnapshot {
            files,
            total_items: mirrors.len(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref_targets_only_picks_connection_references() {
        let mut ledger = Ledger::fresh();
        ledger.set_identity("A");
        let doc = serde_json::json!({
            "commands": [
                {"id": "q1", "sessionKey": "c1"},
                {"id": "q2", "sessionKey": null}
            ]
        });
        let targets = ref_targets(
            "quickCommands",
            &doc,
            &crate::sync::core::ScopeRules::SHARED_ALL,
            crate::sync::core::Platform::Desktop,
            &ledger,
        );
        assert_eq!(
            targets.len(),
            2,
            "两个 sessionKey 叶子都在（null 也是叶子）"
        );
        assert!(targets
            .iter()
            .all(|(p, _)| matches!(p.last(), Some(Seg::Key(k)) if k == "sessionKey")));

        let settings = serde_json::json!({
            "experimentalSettings": {"multiHostConnectionIds": ["c1"]},
            "fontSize": 14
        });
        let targets = ref_targets(
            "settings",
            &settings,
            &crate::sync::core::ScopeRules::SHARED_ALL,
            crate::sync::core::Platform::Desktop,
            &ledger,
        );
        assert_eq!(targets.len(), 1);

        assert!(ref_targets(
            "skills",
            &settings,
            &crate::sync::core::ScopeRules::SHARED_ALL,
            crate::sync::core::Platform::Desktop,
            &ledger
        )
        .is_empty());
    }
}
