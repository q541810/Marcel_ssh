//! 同步记录：别的设备的改动落到本机时留下的流水（含撤销所需的信息）。
//!
//! 生成方式：落地前后各把文档扁平化，逐叶子比对——变了的就是一条记录。两处处理让它读起来
//! 像人话而不是叶子路径：
//! - **整个元素新增 / 删除折成一条**（「新增连接『生产服务器』」），而不是把它的十几个字段各记一条；
//! - 每条带一个 `label`（「连接『生产服务器』的主机地址」）：同步源中文名 + 元素的名字 + 字段中文名。
//!
//! 值只存摘要（长文本截断、对象只说有几项）；撤销要用的完整旧值单独存在 `undo` 里（过大的不存，
//! 对应记录就不可撤销）。**这里不会出现任何机密**：被同步的配置本来就不含密码 / 令牌
//! （`headers`、API Key 都是 Local / 在密钥链里）。

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::core::path::{path_display_string, split_platform_prefix, unescape_key, PrefixKind};
use super::core::{flatten_scoped, IdMapRegistry, Mirror, Path, Platform, ScopeRules, Seg};
use super::docedit;
use super::store::DeviceRecord;
use super::types::{HistoryKind, SyncHistoryEntry};
use crate::config::persist::atomic_write;

/// 最多保留多少条。
pub const HISTORY_CAP: usize = 500;
/// 一次落地最多写多少条（超出的折成一条「另有 N 项」）。
const MAX_RECORDS_PER_APPLY: usize = 200;
/// 撤销用的完整旧值上限（序列化后的字节数）；超过就不可撤销。
const MAX_UNDO_BYTES: usize = 16 * 1024;
/// 值摘要的最大字符数。
const SUMMARY_MAX_CHARS: usize = 80;

/// 怎么把一条改动撤销。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum UndoAction {
    /// 把叶子改回旧值；`old = None` 表示「本来没有」→ 删掉它。
    Leaf { path: Path, old: Option<Value> },
    /// 新增了元素 → 撤销 = 删掉它。
    RemoveElement { path: Path },
    /// 删了元素 → 撤销 = 把当时的整个元素放回去。
    RestoreElement { path: Path, element: Value },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub id: String,
    pub at: String,
    pub device_name: String,
    pub source: String,
    pub path: String,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub kind: HistoryKind,
    pub undone: bool,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undo: Option<UndoAction>,
    /// 警告的去重键：同一条警告只记一次。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dedupe_key: Option<String>,
}

impl HistoryRecord {
    pub fn to_entry(&self) -> SyncHistoryEntry {
        SyncHistoryEntry {
            id: self.id.clone(),
            at: self.at.clone(),
            device_name: self.device_name.clone(),
            source: self.source.clone(),
            path: self.path.clone(),
            old_value: self.old_value.clone(),
            new_value: self.new_value.clone(),
            kind: self.kind,
            undone: self.undone,
            label: self.label.clone(),
        }
    }

    /// 一条警告（没有应用任何东西，正文放在 `label` 与 `new_value` 里）。
    pub fn warning(
        source: &str,
        at: &str,
        device_name: &str,
        path: &[Seg],
        text: &str,
        dedupe_key: &str,
    ) -> Self {
        HistoryRecord {
            id: uuid::Uuid::new_v4().to_string(),
            at: at.to_string(),
            device_name: device_name.to_string(),
            source: source.to_string(),
            path: path_display_string(path),
            old_value: None,
            new_value: Some(text.to_string()),
            kind: HistoryKind::Warning,
            undone: false,
            label: text.to_string(),
            undo: None,
            dedupe_key: Some(dedupe_key.to_string()),
        }
    }

    /// 一条汇总记录（加入同步时「合并了云端的 N 项配置」这类）。
    pub fn summary(source: &str, at: &str, device_name: &str, text: &str) -> Self {
        HistoryRecord {
            id: uuid::Uuid::new_v4().to_string(),
            at: at.to_string(),
            device_name: device_name.to_string(),
            source: source.to_string(),
            path: String::new(),
            old_value: None,
            new_value: None,
            kind: HistoryKind::Change,
            undone: false,
            label: text.to_string(),
            undo: None,
            dedupe_key: None,
        }
    }
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

pub struct HistoryStore {
    path: std::path::PathBuf,
    /// 旧的在前，新的在后。
    records: Vec<HistoryRecord>,
}

impl HistoryStore {
    pub fn load(path: std::path::PathBuf) -> Self {
        let records = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        Self { path, records }
    }

    pub fn empty(path: std::path::PathBuf) -> Self {
        Self {
            path,
            records: Vec::new(),
        }
    }

    fn persist(&self) {
        let write = || -> Result<(), String> {
            let text = serde_json::to_string(&self.records).map_err(|e| e.to_string())?;
            atomic_write(&self.path, &text).map_err(|e| e.to_string())
        };
        if let Err(e) = write() {
            // 记录写不进去不该拖垮同步本身
            log::warn!("写入同步记录失败: {e}");
        }
    }

    /// 追加若干条。同一个 `dedupe_key` 的警告已经在最近记录里就跳过。
    pub fn push_many(&mut self, records: Vec<HistoryRecord>) {
        let mut changed = false;
        for r in records {
            if let Some(key) = &r.dedupe_key {
                if self
                    .records
                    .iter()
                    .any(|old| old.dedupe_key.as_deref() == Some(key.as_str()))
                {
                    continue;
                }
            }
            self.records.push(r);
            changed = true;
        }
        if self.records.len() > HISTORY_CAP {
            let drop = self.records.len() - HISTORY_CAP;
            self.records.drain(..drop);
        }
        if changed {
            self.persist();
        }
    }

    /// 最新的在前。
    pub fn list(&self, limit: usize) -> Vec<SyncHistoryEntry> {
        self.records
            .iter()
            .rev()
            .take(limit)
            .map(HistoryRecord::to_entry)
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<&HistoryRecord> {
        self.records.iter().find(|r| r.id == id)
    }

    pub fn mark_undone(&mut self, id: &str) {
        if let Some(r) = self.records.iter_mut().find(|r| r.id == id) {
            r.undone = true;
            self.persist();
        }
    }

    pub fn clear(&mut self) {
        self.records.clear();
        let _ = std::fs::remove_file(&self.path);
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }
}

// ---------------------------------------------------------------------------
// 人话：来源名、字段名、值摘要
// ---------------------------------------------------------------------------

pub fn source_label(source: &str) -> &str {
    match source {
        "settings" => "设置",
        "connections" => "连接",
        "quickCommands" => "快捷命令",
        "skills" => "技能",
        "mcpServers" => "MCP 服务",
        "knownHosts" => "已知主机",
        other => other,
    }
}

/// 设置顶层字段的中文名（认不得的字段原样显示，不猜）。
fn setting_label(key: &str) -> &str {
    match key {
        "fontSize" => "终端字号",
        "fontFamily" => "终端字体",
        "terminalColors" => "终端配色",
        "uiTheme" => "应用主题",
        "defaultAgentMode" => "默认 Agent 模式",
        "privacyMode" => "隐私模式",
        "showMascot" => "显示玛瑟尔",
        "llmRegistry" => "模型服务",
        "agentModeSettings" => "Agent 策略",
        "experimentalSettings" => "工具能力",
        "memorySettings" => "记忆",
        "customProtectedPaths" => "受保护路径",
        "riskRuleOverrides" => "风险规则",
        "customRiskRules" => "自定义风险规则",
        "hideThinkingDisplay" => "隐藏思考过程",
        "foldCompletedTurns" => "折叠已完成回合",
        "archiveRetentionDays" => "归档保留天数",
        "commandTimeoutSecs" => "命令超时",
        "folderUploadCompressionLevel" => "文件夹压缩等级",
        "fileManagerShowHidden" => "文件管理器显示隐藏文件",
        "notificationSettings" => "通知",
        "mobileNotificationSettings" => "手机通知",
        other => other,
    }
}

/// 元素字段的中文名。
fn field_label(key: &str) -> &str {
    match key {
        "name" => "名称",
        "displayName" => "显示名",
        "host" => "主机地址",
        "port" => "端口",
        "username" => "用户名",
        "authMethod" => "认证方式",
        "group" => "分组",
        "useJump" => "是否使用跳板机",
        "jumpHost" => "跳板机地址",
        "jumpPort" => "跳板机端口",
        "jumpUsername" => "跳板机用户名",
        "jumpAuthMethod" => "跳板机认证方式",
        "remotePlatform" => "远端系统",
        "description" => "描述",
        "prompt" => "提示词",
        "enabled" => "启用状态",
        "resources" => "附属资源",
        "position" => "排序位置",
        "url" => "地址",
        "baseUrl" => "接口地址",
        "modelName" => "模型名",
        "channelId" => "所属渠道",
        "commands" => "命令内容",
        "intervalMs" => "执行间隔",
        "insertOnly" => "仅插入不执行",
        "scope" => "范围",
        "sessionKey" => "所属连接",
        "createdAt" => "创建时间",
        "updatedAt" => "更新时间",
        "algorithm" => "算法",
        "fingerprint_sha256" => "指纹",
        "command" => "命令",
        "argContains" => "参数关键字",
        "level" => "档位",
        "message" => "说明",
        other => other,
    }
}

/// 列表所在位置的最后一段 key → 元素的称呼。
fn element_noun(list_key: &str) -> &str {
    match list_key {
        "connections" => "连接",
        "commands" => "快捷指令",
        "skills" => "技能",
        "servers" => "MCP 服务",
        "channels" => "模型渠道",
        "models" => "模型",
        "customRiskRules" => "自定义风险规则",
        _ => "条目",
    }
}

fn short_id(id: &str) -> String {
    let cleaned: String = id.chars().filter(|c| *c != '-').take(6).collect();
    format!("#{cleaned}")
}

/// 值摘要：给人看的短文本。
pub fn summarize(v: &Value) -> String {
    match v {
        Value::Null => "（空）".to_string(),
        Value::Bool(true) => "开启".to_string(),
        Value::Bool(false) => "关闭".to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => truncate_chars(s, SUMMARY_MAX_CHARS),
        Value::Array(a) => {
            if a.iter()
                .all(|e| matches!(e, Value::String(_) | Value::Number(_)))
                && !a.is_empty()
            {
                let joined = a
                    .iter()
                    .map(|e| match e {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join("、");
                truncate_chars(&joined, SUMMARY_MAX_CHARS)
            } else {
                format!("{} 项", a.len())
            }
        }
        Value::Object(m) => format!("{} 个字段", m.len()),
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    let mut it = s.chars();
    let head: String = it.by_ref().take(max).collect();
    if it.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

// ---------------------------------------------------------------------------
// 比对生成记录
// ---------------------------------------------------------------------------

pub struct ChangeCtx<'a> {
    pub source: &'a str,
    pub rules: &'a ScopeRules,
    pub platform: Platform,
    pub idmaps: &'a IdMapRegistry,
    /// 用来判断每处改动出自哪台设备（赢家叶子的 hlc.device）。
    pub mirror: &'a Mirror,
    pub devices: &'a BTreeMap<String, DeviceRecord>,
    pub self_device_id: &'a str,
    pub at: &'a str,
}

fn has_prefix(map: &BTreeMap<Path, Value>, prefix: &[Seg]) -> bool {
    use std::ops::Bound;
    map.range::<[Seg], _>((Bound::Included(prefix), Bound::Unbounded))
        .next()
        .is_some_and(|(k, _)| k.starts_with(prefix))
}

/// 路径里可能是「元素」的前缀长度（从外到内）：每个 `Id` 段，加上 known_hosts 的 `entries/<主机>`。
fn element_prefix_lens(source: &str, path: &[Seg]) -> Vec<usize> {
    let mut out: Vec<usize> = path
        .iter()
        .enumerate()
        .filter(|(_, s)| s.is_id())
        .map(|(i, _)| i + 1)
        .collect();
    if source == "knownHosts" {
        let (_, rest) = split_platform_prefix(path, Platform::current());
        let offset = path.len() - rest.len();
        if rest.len() >= 3 && matches!(&rest[0], Seg::Key(k) if k == "entries") {
            out.push(offset + 2);
            out.sort_unstable();
            out.dedup();
        }
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Wholly {
    Added,
    Removed,
}

fn doc_path(path: &[Seg], platform: Platform) -> &[Seg] {
    match split_platform_prefix(path, platform) {
        (PrefixKind::Own, rest) | (PrefixKind::None, rest) => rest,
        (PrefixKind::Other, rest) => rest,
    }
}

/// 元素的称呼：名字字段优先，没有就用短 id。
fn element_name(doc: &Value, elem_doc_path: &[Seg]) -> Option<String> {
    let el = docedit::get_leaf(doc, elem_doc_path)?;
    for key in ["name", "displayName", "modelName", "command"] {
        if let Some(s) = el.get(key).and_then(Value::as_str) {
            if !s.trim().is_empty() {
                return Some(s.trim().to_string());
            }
        }
    }
    match elem_doc_path.last() {
        Some(Seg::Id { id }) => Some(short_id(id)),
        _ => None,
    }
}

fn list_noun(source: &str, elem_doc_path: &[Seg]) -> String {
    if source == "knownHosts" {
        return "主机".to_string();
    }
    let list_key = elem_doc_path
        .len()
        .checked_sub(2)
        .and_then(|i| elem_doc_path.get(i))
        .and_then(|s| match s {
            Seg::Key(k) => Some(unescape_key(k)),
            _ => None,
        })
        .unwrap_or("");
    element_noun(list_key).to_string()
}

fn key_text(seg: &Seg) -> String {
    match seg {
        Seg::Key(k) => unescape_key(k).to_string(),
        Seg::Id { id } => short_id(id),
        Seg::Order { .. } => "顺序".to_string(),
    }
}

/// 落地前后的差异 → 记录。
pub fn change_records(ctx: &ChangeCtx<'_>, before: &Value, after: &Value) -> Vec<HistoryRecord> {
    let mut reg = ctx.idmaps.clone();
    let b = flatten_scoped(before, ctx.rules, ctx.platform, &mut reg);
    let a = flatten_scoped(after, ctx.rules, ctx.platform, &mut reg);

    let keys: BTreeSet<&Path> = b.keys().chain(a.keys()).collect();
    let mut elements_done: BTreeSet<Path> = BTreeSet::new();
    let mut out: Vec<HistoryRecord> = Vec::new();

    for path in keys {
        let (old, new) = (b.get(path), a.get(path));
        if old == new {
            continue;
        }
        if path.last().is_some_and(Seg::is_order) {
            if let Some(rec) = order_record(ctx, path, old, new, before, after) {
                out.push(rec);
            }
            continue;
        }

        // 整个元素新增 / 删除 → 折成一条（取最外层）
        let wholly = element_prefix_lens(ctx.source, path)
            .into_iter()
            .find_map(|len| {
                let prefix = &path[..len];
                match (has_prefix(&b, prefix), has_prefix(&a, prefix)) {
                    (false, true) => Some((len, Wholly::Added)),
                    (true, false) => Some((len, Wholly::Removed)),
                    _ => None,
                }
            });
        if let Some((len, kind)) = wholly {
            let elem: Path = path[..len].to_vec();
            if elements_done.insert(elem.clone()) {
                out.push(element_record(ctx, &elem, kind, before, after, path));
            }
            continue;
        }

        out.push(leaf_record(ctx, path, old, new, before, after));
    }

    if out.len() > MAX_RECORDS_PER_APPLY {
        let extra = out.len() - MAX_RECORDS_PER_APPLY;
        out.truncate(MAX_RECORDS_PER_APPLY);
        out.push(HistoryRecord::summary(
            ctx.source,
            ctx.at,
            "其它设备",
            &format!("{}另有 {extra} 项变更（已省略）", source_label(ctx.source)),
        ));
    }
    out
}

fn who(ctx: &ChangeCtx<'_>, path: &[Seg], elem: Option<&[Seg]>) -> String {
    let id = ctx
        .mirror
        .leaf(path)
        .map(|e| e.hlc.device.clone())
        .or_else(|| elem.and_then(|e| ctx.mirror.tombstone(e).map(|h| h.device.clone())));
    match id {
        Some(id) if id == ctx.self_device_id => "本机".to_string(),
        Some(id) => ctx
            .devices
            .get(&id)
            .map(|d| d.name.clone())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "其它设备".to_string()),
        None => "其它设备".to_string(),
    }
}

fn leaf_record(
    ctx: &ChangeCtx<'_>,
    path: &Path,
    old: Option<&Value>,
    new: Option<&Value>,
    before: &Value,
    after: &Value,
) -> HistoryRecord {
    let dpath = doc_path(path, ctx.platform);
    let scope_note = match split_platform_prefix(path, ctx.platform).0 {
        PrefixKind::Own => match ctx.platform {
            Platform::Desktop => "（仅桌面端）",
            Platform::Android => "（仅手机端）",
        },
        _ => "",
    };
    let label = leaf_label(ctx.source, dpath, before, after);
    let undo = if ctx.source == "knownHosts" {
        None // 主机指纹只能由用户在本机确认后改，不提供一键撤销
    } else if old.is_none_or(|v| v.to_string().len() <= MAX_UNDO_BYTES) {
        Some(UndoAction::Leaf {
            path: path.clone(),
            old: old.cloned(),
        })
    } else {
        None
    };
    HistoryRecord {
        id: uuid::Uuid::new_v4().to_string(),
        at: ctx.at.to_string(),
        device_name: who(ctx, path, None),
        source: ctx.source.to_string(),
        path: path_display_string(path),
        old_value: old.map(summarize),
        new_value: new.map(summarize),
        kind: HistoryKind::Change,
        undone: false,
        label: format!("{label}{scope_note}"),
        undo,
        dedupe_key: None,
    }
}

fn leaf_label(source: &str, dpath: &[Seg], before: &Value, after: &Value) -> String {
    // 最近的一个元素前缀（有 Id 段）
    if let Some(i) = dpath.iter().rposition(Seg::is_id) {
        let elem = &dpath[..=i];
        let name = element_name(after, elem)
            .or_else(|| element_name(before, elem))
            .unwrap_or_else(|| "（未命名）".to_string());
        let noun = list_noun(source, elem);
        let rest = &dpath[i + 1..];
        let field = if rest.is_empty() {
            String::new()
        } else {
            rest.iter()
                .map(|s| match s {
                    Seg::Key(k) => field_label(unescape_key(k)).to_string(),
                    other => key_text(other),
                })
                .collect::<Vec<_>>()
                .join(" › ")
        };
        let prefix = if source == "settings" {
            "设置 · "
        } else {
            ""
        };
        return if field.is_empty() {
            format!("{prefix}{noun}『{name}』")
        } else {
            format!("{prefix}{noun}『{name}』的{field}")
        };
    }
    if source == "knownHosts" {
        if let (Some(Seg::Key(entries)), Some(Seg::Key(host))) = (dpath.first(), dpath.get(1)) {
            if entries == "entries" {
                let field = dpath
                    .get(2)
                    .map(|s| match s {
                        Seg::Key(k) => field_label(unescape_key(k)).to_string(),
                        other => key_text(other),
                    })
                    .unwrap_or_default();
                return format!("已知主机 {} 的{}", unescape_key(host), field);
            }
        }
    }
    if source == "settings" {
        let mut parts = dpath.iter().map(|s| match s {
            Seg::Key(k) => k.as_str(),
            _ => "",
        });
        let head = parts.next().map(unescape_key).unwrap_or("");
        let head_label = setting_label(head).to_string();
        let rest: Vec<String> = dpath
            .iter()
            .skip(1)
            .map(|s| match s {
                Seg::Key(k) => field_label(unescape_key(k)).to_string(),
                other => key_text(other),
            })
            .collect();
        return if rest.is_empty() {
            format!("设置 · {head_label}")
        } else {
            format!("设置 · {head_label} › {}", rest.join(" › "))
        };
    }
    let joined = dpath.iter().map(key_text).collect::<Vec<_>>().join(" › ");
    format!("{} · {joined}", source_label(source))
}

fn element_record(
    ctx: &ChangeCtx<'_>,
    elem: &Path,
    kind: Wholly,
    before: &Value,
    after: &Value,
    sample_leaf: &Path,
) -> HistoryRecord {
    let delem = doc_path(elem, ctx.platform);
    let (name, doc_for_name) = match kind {
        Wholly::Added => (element_name(after, delem), after),
        Wholly::Removed => (element_name(before, delem), before),
    };
    let name = name.unwrap_or_else(|| match delem.last() {
        Some(s) => key_text(s),
        None => String::new(),
    });
    let (noun, display_name) = if ctx.source == "knownHosts" {
        ("主机".to_string(), name.clone())
    } else {
        (list_noun(ctx.source, delem), name.clone())
    };
    let label = match (ctx.source, kind) {
        ("knownHosts", Wholly::Added) => format!("已信任主机 {display_name} 的指纹"),
        ("knownHosts", Wholly::Removed) => format!("移除了主机 {display_name} 的指纹记录"),
        (_, Wholly::Added) => format!("新增{noun}『{display_name}』"),
        (_, Wholly::Removed) => format!("删除{noun}『{display_name}』"),
    };
    let label = if ctx.source == "settings" {
        format!("设置 · {label}")
    } else {
        label
    };
    let undo = if ctx.source == "knownHosts" {
        None
    } else {
        match kind {
            Wholly::Added => Some(UndoAction::RemoveElement { path: elem.clone() }),
            Wholly::Removed => docedit::get_leaf(doc_for_name, delem)
                .filter(|el| el.to_string().len() <= MAX_UNDO_BYTES)
                .map(|el| UndoAction::RestoreElement {
                    path: elem.clone(),
                    element: el.clone(),
                }),
        }
    };
    HistoryRecord {
        id: uuid::Uuid::new_v4().to_string(),
        at: ctx.at.to_string(),
        device_name: who(ctx, sample_leaf, Some(elem)),
        source: ctx.source.to_string(),
        path: path_display_string(elem),
        old_value: matches!(kind, Wholly::Removed).then(|| display_name.clone()),
        new_value: matches!(kind, Wholly::Added).then(|| display_name.clone()),
        kind: HistoryKind::Change,
        undone: false,
        label,
        undo,
        dedupe_key: None,
    }
}

/// 顺序叶子：只有「同一批元素、次序变了」才值得记一条；增删元素引起的顺序叶子变化不重复记。
fn order_record(
    ctx: &ChangeCtx<'_>,
    path: &Path,
    old: Option<&Value>,
    new: Option<&Value>,
    before: &Value,
    after: &Value,
) -> Option<HistoryRecord> {
    let ids = |v: Option<&Value>| -> Option<Vec<String>> {
        Some(
            v?.as_array()?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
        )
    };
    let (old_ids, new_ids) = (ids(old)?, ids(new)?);
    let a: BTreeSet<&String> = old_ids.iter().collect();
    let b: BTreeSet<&String> = new_ids.iter().collect();
    if a != b || old_ids == new_ids {
        return None;
    }
    let list_path = &path[..path.len() - 1];
    let dlist = doc_path(list_path, ctx.platform);
    let noun = match dlist.last() {
        Some(Seg::Key(k)) => element_noun(unescape_key(k)).to_string(),
        _ => "条目".to_string(),
    };
    let _ = (before, after);
    let prefix = if ctx.source == "settings" {
        "设置 · "
    } else {
        ""
    };
    Some(HistoryRecord {
        id: uuid::Uuid::new_v4().to_string(),
        at: ctx.at.to_string(),
        device_name: who(ctx, path, None),
        source: ctx.source.to_string(),
        path: path_display_string(path),
        old_value: None,
        new_value: None,
        kind: HistoryKind::Change,
        undone: false,
        label: format!("{prefix}{noun}的排列顺序"),
        undo: None,
        dedupe_key: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::core::{Hlc, Op, OpKind};
    use crate::sync::scopes::{CONNECTIONS_RULES, SETTINGS_RULES};
    use serde_json::json;

    fn devices() -> BTreeMap<String, DeviceRecord> {
        let mut m = BTreeMap::new();
        m.insert(
            "dev-phone".to_string(),
            DeviceRecord {
                name: "我的手机".into(),
                ..Default::default()
            },
        );
        m
    }

    fn mirror_with_leaf(path: Path, device: &str) -> Mirror {
        let mut m = Mirror::new();
        m.merge(&Op {
            source: "x".into(),
            path,
            kind: OpKind::Set(json!(1)),
            hlc: Hlc {
                ms: 5,
                counter: 0,
                device: device.into(),
            },
        });
        m
    }

    fn run(
        source: &str,
        rules: &ScopeRules,
        mirror: &Mirror,
        before: &Value,
        after: &Value,
    ) -> Vec<HistoryRecord> {
        let devs = devices();
        let idmaps = IdMapRegistry::new();
        let ctx = ChangeCtx {
            source,
            rules,
            platform: Platform::Desktop,
            idmaps: &idmaps,
            mirror,
            devices: &devs,
            self_device_id: "dev-me",
            at: "2026-10-30T00:00:00Z",
        };
        change_records(&ctx, before, after)
    }

    #[test]
    fn setting_change_has_a_human_label_and_value_summaries() {
        let mirror = mirror_with_leaf(
            vec![Seg::key("@desktop"), Seg::key("fontSize")],
            "dev-phone",
        );
        let recs = run(
            "settings",
            &SETTINGS_RULES,
            &mirror,
            &json!({"fontSize": 14, "privacyMode": false}),
            &json!({"fontSize": 18, "privacyMode": true}),
        );
        let font = recs.iter().find(|r| r.label.contains("终端字号")).unwrap();
        assert_eq!(font.label, "设置 · 终端字号（仅桌面端）");
        assert_eq!(font.old_value.as_deref(), Some("14"));
        assert_eq!(font.new_value.as_deref(), Some("18"));
        assert_eq!(font.device_name, "我的手机", "按赢家叶子的设备归属");
        let privacy = recs.iter().find(|r| r.label.contains("隐私模式")).unwrap();
        assert_eq!(privacy.new_value.as_deref(), Some("开启"));
        assert_eq!(privacy.device_name, "其它设备", "镜像里查不到就不瞎猜");
    }

    #[test]
    fn nested_setting_gets_a_readable_label() {
        let recs = run(
            "settings",
            &SETTINGS_RULES,
            &Mirror::new(),
            &json!({"agentModeSettings": {"maxToolRounds": 500}}),
            &json!({"agentModeSettings": {"maxToolRounds": 100}}),
        );
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].label, "设置 · Agent 策略 › maxToolRounds");
    }

    #[test]
    fn field_change_inside_an_element_names_the_element() {
        let before =
            json!({"connections": [{"id": "c1", "name": "生产服务器", "host": "1.1.1.1"}]});
        let after = json!({"connections": [{"id": "c1", "name": "生产服务器", "host": "2.2.2.2"}]});
        let recs = run(
            "connections",
            &CONNECTIONS_RULES,
            &Mirror::new(),
            &before,
            &after,
        );
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].label, "连接『生产服务器』的主机地址");
        assert_eq!(recs[0].old_value.as_deref(), Some("1.1.1.1"));
        assert_eq!(recs[0].path, "connections/[c1]/host");
        assert!(matches!(recs[0].undo, Some(UndoAction::Leaf { .. })));
    }

    #[test]
    fn adding_and_removing_whole_elements_collapse_into_one_record_each() {
        let before = json!({"connections": [
            {"id": "gone", "name": "旧机器", "host": "h", "port": 22, "username": "u", "authMethod": "Password"}
        ]});
        let after = json!({"connections": [
            {"id": "new", "name": "新机器", "host": "h2", "port": 22, "username": "u", "authMethod": "Password"}
        ]});
        let recs = run(
            "connections",
            &CONNECTIONS_RULES,
            &Mirror::new(),
            &before,
            &after,
        );
        let labels: Vec<&str> = recs.iter().map(|r| r.label.as_str()).collect();
        assert_eq!(
            labels.len(),
            2,
            "两个元素各一条，而不是十几个字段各一条: {labels:?}"
        );
        assert!(labels.contains(&"新增连接『新机器』"));
        assert!(labels.contains(&"删除连接『旧机器』"));
        let removed = recs.iter().find(|r| r.label.starts_with("删除")).unwrap();
        match &removed.undo {
            Some(UndoAction::RestoreElement { element, .. }) => {
                assert_eq!(element["name"], json!("旧机器"));
            }
            other => panic!("删除元素应能整个放回去: {other:?}"),
        }
        let added = recs.iter().find(|r| r.label.starts_with("新增")).unwrap();
        assert!(matches!(added.undo, Some(UndoAction::RemoveElement { .. })));
    }

    #[test]
    fn reordering_the_same_elements_is_recorded_but_add_or_remove_is_not_double_counted() {
        let make = |ids: &[&str]| json!({"connections": ids.iter().map(|i| json!({"id": i, "name": i})).collect::<Vec<_>>()});
        let reorder = run(
            "connections",
            &CONNECTIONS_RULES,
            &Mirror::new(),
            &make(&["a", "b"]),
            &make(&["b", "a"]),
        );
        assert_eq!(reorder.len(), 1);
        assert_eq!(reorder[0].label, "连接的排列顺序");

        let add = run(
            "connections",
            &CONNECTIONS_RULES,
            &Mirror::new(),
            &make(&["a"]),
            &make(&["a", "b"]),
        );
        assert_eq!(
            add.len(),
            1,
            "只有「新增连接」一条，顺序叶子的变化不重复记: {add:?}"
        );
        assert_eq!(add[0].label, "新增连接『b』");
    }

    #[test]
    fn known_host_entries_collapse_per_host_and_are_not_undoable() {
        let before = json!({"version": 1, "entries": {}});
        let after = json!({"version": 1, "entries": {"1.2.3.4:22": {
            "algorithm": "ssh-ed25519", "fingerprint_sha256": "SHA256:x",
            "first_seen": "t", "last_seen": "t"}}});
        let recs = run(
            "knownHosts",
            &crate::sync::scopes::KNOWN_HOSTS_RULES,
            &Mirror::new(),
            &before,
            &after,
        );
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].label, "已信任主机 1.2.3.4:22 的指纹");
        assert!(recs[0].undo.is_none());
    }

    #[test]
    fn local_fields_never_show_up_in_the_history() {
        let recs = run(
            "settings",
            &SETTINGS_RULES,
            &Mirror::new(),
            &json!({"panelHeight": 200, "updateMode": "auto"}),
            &json!({"panelHeight": 300, "updateMode": "off"}),
        );
        assert!(recs.is_empty());
    }

    #[test]
    fn summaries_truncate_long_text_and_describe_structures() {
        let long = "字".repeat(200);
        let s = summarize(&json!(long));
        assert_eq!(s.chars().count(), SUMMARY_MAX_CHARS + 1);
        assert!(s.ends_with('…'));
        assert_eq!(summarize(&json!({"a": 1, "b": 2})), "2 个字段");
        assert_eq!(summarize(&json!([{"id": 1}, {"id": 2}])), "2 项");
        assert_eq!(summarize(&json!(["a", "b"])), "a、b");
        assert_eq!(summarize(&json!(null)), "（空）");
    }

    #[test]
    fn oversized_old_values_are_not_undoable() {
        let big = "x".repeat(MAX_UNDO_BYTES + 10);
        let recs = run(
            "settings",
            &SETTINGS_RULES,
            &Mirror::new(),
            &json!({"agentModeSettings": {"systemPrompt": big}}),
            &json!({"agentModeSettings": {"systemPrompt": "短"}}),
        );
        assert_eq!(recs.len(), 1);
        assert!(recs[0].undo.is_none());
        assert!(recs[0].old_value.as_deref().unwrap().chars().count() <= SUMMARY_MAX_CHARS + 1);
    }

    #[test]
    fn store_caps_dedupes_warnings_and_marks_undone() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("history.json");
        let mut store = HistoryStore::load(path.clone());

        let w = |key: &str| {
            HistoryRecord::warning(
                "knownHosts",
                "t",
                "手机",
                &[Seg::key("entries")],
                "警告",
                key,
            )
        };
        store.push_many(vec![w("k1"), w("k1"), w("k2")]);
        assert_eq!(store.len(), 2, "同一个 dedupe_key 只记一次");
        store.push_many(vec![w("k1")]);
        assert_eq!(store.len(), 2, "跨批次也去重");

        let id = store.list(10)[0].id.clone();
        store.mark_undone(&id);
        assert!(store.get(&id).unwrap().undone);

        // 重新加载：持久化了
        let again = HistoryStore::load(path);
        assert_eq!(again.len(), 2);
        assert!(again.get(&id).unwrap().undone);

        // 上限
        let mut capped = HistoryStore::empty(tmp.path().join("h2.json"));
        let many: Vec<HistoryRecord> = (0..HISTORY_CAP + 30)
            .map(|i| HistoryRecord::summary("settings", "t", "x", &format!("n{i}")))
            .collect();
        capped.push_many(many);
        assert_eq!(capped.len(), HISTORY_CAP);
        assert_eq!(
            capped.list(1)[0].label,
            format!("n{}", HISTORY_CAP + 29),
            "最新的在最前"
        );
    }
}
