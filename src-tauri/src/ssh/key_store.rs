//! 私钥库：把用户导入的 SSH 私钥**加密**收进应用自己的目录。
//!
//! 为什么需要它：私钥认证只认「一个 russh 能读到的真实文件路径」。桌面上用户给得出，
//! Android 上给不出——应用没有存储权限，系统文件选择器交出来的又是一张 `content://`
//! 取件凭据而不是文件。所以补一个导入步骤：把私钥（来自本地文件、`content://` 或
//! 用户粘贴的文本）复制进应用私有目录，此后连接链路不需要任何改动。
//!
//! 落盘的是**密文**：真正的钥匙是一把 32 字节随机量，交给系统密钥链保管（Android 由
//! Android Keystore 硬件级保护，桌面由系统凭据存储保护）；私钥用它做 AES-256-GCM
//! 加密后写盘。这样即便应用数据目录被整个端走——Android 的应用数据默认会被自动备份
//! 到云端，这条路径是真实存在的——拿到的也只是解不开的密文。
//!
//! 诚实边界：解密用的那把钥匙就在同一台设备上，所以这层防的是「设备或备份被离线
//! 带走」，**防不住**已经以当前用户身份运行的程序；也不替代私钥自身的 passphrase
//! ——带密码的私钥原样保留其加密形态，我们只是在外面再套一层。
//!
//! 代价：换设备从备份恢复后，密文解不开（主密钥不进备份），此时明确提示「请重新导入」，
//! 而不是抛一个底层错误。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::config::keychain;
use crate::error::{AppError, KeyAuthCode};
use crate::ssh::key_material;

/// 主密钥在系统密钥链里的账号名。32 字节 base64 后 44 个字符，
/// 远小于各处凭据存储的体积上限（Windows 那条约 1280 字符）。
const MASTER_KEY_ACCOUNT: &str = "keys:master";
const INDEX_FILE: &str = "index.json";
/// 封装格式版本。换算法时靠它区分，不猜。
const ENVELOPE_VERSION: u32 = 1;

static KEYS_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// 记录应用配置目录下的密钥库位置（`{config_dir}/keys`）。
/// 可重复调用，只有第一次生效——与 `agent::image_store` 同一套惯例。
pub fn init(config_dir: &Path) {
    let root = config_dir.join("keys");
    if let Err(e) = std::fs::create_dir_all(&root) {
        log::warn!("创建密钥库目录失败 {}: {}", root.display(), e);
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // 目录限当前用户：密文之外，元数据（密钥名字）也不该被别人看到
        let _ = std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700));
    }
    let _ = KEYS_ROOT.set(root);
}

fn store() -> KeyStore {
    KeyStore::new(
        KEYS_ROOT
            .get()
            .cloned()
            .unwrap_or_else(|| PathBuf::from("keys")),
    )
}

/// 一把已导入的私钥的可公开元数据。
///
/// 只含能给人看的东西：**没有私钥内容、没有 passphrase**。前端只拿它做展示与选择，
/// 密钥正文永远留在 Rust 侧（与 `ssh::auth::AuthMethod` 只实现 `Deserialize` 同一条纪律）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredKeyMeta {
    pub id: String,
    /// 用户起的名字；没给就用导入来源的文件名
    pub name: String,
    /// 例如 `ssh-ed25519` / `ssh-rsa`
    pub algorithm: String,
    /// 例如 `SHA256:AbC…`——导入后展示给用户核对"是不是这把钥匙"
    pub fingerprint: String,
    /// 私钥自身是否带 passphrase（连接前据此决定要不要问密码）
    pub encrypted: bool,
    /// 导入来源（来自真实文件路径时才有）。用于提醒"你原来的密钥文件变了"
    #[serde(default)]
    pub origin_path: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct KeyIndex {
    #[serde(default)]
    keys: Vec<StoredKeyMeta>,
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    v: u32,
    nonce: String,
    ct: String,
}

// ── 对外：密钥库操作 ────────────────────────────────────────────────────────

/// 导入一段私钥文本。带 passphrase 的私钥必须在这里就给对密码：
/// 解不开就无法确认身份（拿不到指纹），也就没法让用户核对"导的是哪一把"。
pub fn import_text(
    text: &str,
    name: &str,
    origin_path: Option<&str>,
    passphrase: Option<&str>,
) -> Result<StoredKeyMeta, AppError> {
    store().import_text(text, name, origin_path, passphrase)
}

/// 列出已导入的私钥（导入顺序，即界面展示顺序）。
pub fn list() -> Vec<StoredKeyMeta> {
    store().load_index().keys
}

/// 取单个条目的元数据。
pub fn get(id: &str) -> Option<StoredKeyMeta> {
    store().load_index().keys.into_iter().find(|k| k.id == id)
}

/// 读出某条目的私钥文本（已解密）。仅 Rust 侧使用。
pub fn load_pem(id: &str) -> Result<Zeroizing<String>, AppError> {
    store().load_pem(id)
}

/// 重命名。
pub fn rename(id: &str, name: &str) -> Result<StoredKeyMeta, AppError> {
    store().rename(id, name)
}

/// 删除条目（连同密文文件）。注意：**不会**碰任何连接配置——
/// 一把密钥可以被多条连接共用，删连接也不该删密钥。
pub fn delete(id: &str) -> Result<(), AppError> {
    store().delete(id)
}

/// 导入来源的现状。用来堵一个静默失效的坑：用户重新生成密钥之后，
/// 库里那份还是旧的，连接会以"服务器拒绝"收场，而他明明把新的公钥加上去了。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginStatus {
    pub origin_path: String,
    /// 原文件已经不在了（不影响使用，库里这份是独立的）
    pub missing: bool,
    /// 原文件还在、但已经是另一把钥匙了
    pub changed: bool,
}

/// 比对"导入来源"与库里那份私钥是否还是同一把（按指纹比，不看字节：
/// 同一把密钥换个格式导出，字节不同但指纹相同，那不算变更）。
pub fn origin_status(id: &str) -> Result<Option<OriginStatus>, AppError> {
    store().origin_status(id)
}

/// 用导入来源的**当前内容**刷新库里那一份（同一个 id，原地换掉）。
///
/// 为什么必须原地换、而不是当成"又导入了一把新的"：连接引用的是 id。新开一个条目
/// 会让那些连接继续指着旧的，用户点了"更新"却发现连接还是用旧钥匙——比不提供这个
/// 功能更糟。返回 `Ok(None)` 表示这条没有来源可刷。
pub fn replace_from_origin(
    id: &str,
    passphrase: Option<&str>,
) -> Result<Option<StoredKeyMeta>, AppError> {
    store().replace_from_origin(id, passphrase)
}

/// 只取公开部分的指纹：加密的 OpenSSH 私钥解不开正文，但公开部分是明文，
/// 身份照样认得出来。
fn public_fingerprint(text: &str) -> Option<String> {
    russh::keys::ssh_key::PrivateKey::from_openssh(text)
        .ok()
        .map(|key| key.fingerprint(russh::keys::HashAlg::Sha256).to_string())
}

/// 连接时解析私钥文本：优先密钥库条目，否则回落到用户手填的文件路径。
///
/// 两条路都保留是有意的——密钥库是新数据的主路径（`key_id`），而老数据以及
/// "我就想直接指向 ~/.ssh/id_rsa 这个活文件"的高级用法仍然靠 `key_path`。
pub fn resolve_pem(
    key_id: Option<&str>,
    key_path: Option<&str>,
) -> Result<Zeroizing<String>, AppError> {
    if let Some(id) = key_id.map(str::trim).filter(|s| !s.is_empty()) {
        return load_pem(id);
    }
    match key_path.map(str::trim).filter(|s| !s.is_empty()) {
        Some(path) => Ok(Zeroizing::new(key_material::read_key_file(path)?)),
        None => Err(key_error(
            KeyAuthCode::KeyMissingFromStore,
            "这个连接还没有指定私钥，请在连接设置里选择或导入一把私钥",
        )),
    }
}

// ── 内部实现 ────────────────────────────────────────────────────────────────

fn key_error(code: KeyAuthCode, message: impl Into<String>) -> AppError {
    AppError::KeyAuth {
        code,
        message: message.into(),
    }
}

fn undecryptable() -> AppError {
    key_error(
        KeyAuthCode::KeyMissingFromStore,
        "这把密钥无法解密（可能是换了设备、或从备份恢复过来的），请重新导入一次",
    )
}

fn missing_entry() -> AppError {
    key_error(
        KeyAuthCode::KeyMissingFromStore,
        "这个连接引用的密钥已被删除，请重新选择一把",
    )
}

struct KeyStore {
    root: PathBuf,
}

impl KeyStore {
    fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn index_path(&self) -> PathBuf {
        self.root.join(INDEX_FILE)
    }

    fn key_file_path(&self, id: &str) -> PathBuf {
        self.root.join(format!("{}.key", id))
    }

    /// 读索引。文件缺失或损坏时**不当作"没有密钥"**，而是扫目录重建——
    /// 密钥文件本身才是用户的数据，索引只是它的目录页；让目录页的损坏
    /// 表现成"密钥全没了"是会把用户吓到的假象。
    fn load_index(&self) -> KeyIndex {
        let path = self.index_path();
        match std::fs::read_to_string(&path) {
            Ok(text) if !text.trim().is_empty() => match serde_json::from_str(&text) {
                Ok(index) => index,
                Err(e) => {
                    log::warn!("密钥库索引损坏，改为按文件重建: {}", e);
                    self.rebuild_index()
                }
            },
            _ => {
                let rebuilt = self.rebuild_index();
                if !rebuilt.keys.is_empty() {
                    log::warn!("密钥库索引缺失，已按已有密钥文件重建");
                }
                rebuilt
            }
        }
    }

    /// 按目录里的密文文件重建索引（用户起的名字拿不回来，退化成指纹前缀）。
    fn rebuild_index(&self) -> KeyIndex {
        let mut keys = Vec::new();
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return KeyIndex::default();
        };
        let mut ids: Vec<String> = entries
            .flatten()
            .filter_map(|e| {
                let path = e.path();
                if path.extension().and_then(|x| x.to_str()) != Some("key") {
                    return None;
                }
                path.file_stem().and_then(|s| s.to_str()).map(str::to_string)
            })
            .collect();
        ids.sort();

        let master = match master_key() {
            Ok(m) => m,
            Err(e) => {
                log::warn!("密钥库重建跳过：读不到主密钥（{}）", e);
                return KeyIndex::default();
            }
        };

        for id in ids {
            let Ok(text) = std::fs::read_to_string(self.key_file_path(&id)) else {
                continue;
            };
            let Ok(pem) = open_envelope(&master, &id, &text) else {
                log::warn!("密钥库重建跳过 {}：密文解不开", id);
                continue;
            };
            match rebuild_meta(&id, &pem) {
                Some(meta) => keys.push(meta),
                None => log::warn!("密钥库重建跳过 {}：私钥格式无法识别", id),
            }
        }
        KeyIndex { keys }
    }

    fn save_index(&self, index: &KeyIndex) -> Result<(), AppError> {
        let json = serde_json::to_string_pretty(index)
            .map_err(|e| AppError::Config(format!("序列化密钥库索引失败：{}", e)))?;
        crate::config::persist::atomic_write(&self.index_path(), &json)
            .map_err(|e| AppError::Config(format!("写入密钥库索引失败：{}", e)))
    }

    fn import_text(
        &self,
        text: &str,
        name: &str,
        origin_path: Option<&str>,
        passphrase: Option<&str>,
    ) -> Result<StoredKeyMeta, AppError> {
        if text.len() > key_material::MAX_KEY_BYTES {
            return Err(key_error(
                KeyAuthCode::UnsupportedKey,
                "这个文件太大，不像是私钥",
            ));
        }
        // 解一次：既校验内容，也拿到身份（指纹）供用户核对
        let key = key_material::decode_pem(text, passphrase)?;
        let fingerprint = key.fingerprint(russh::keys::HashAlg::Sha256).to_string();
        let algorithm = key.algorithm().to_string();
        let encrypted = key_material::is_encrypted(text);

        if let Err(e) = std::fs::create_dir_all(&self.root) {
            return Err(AppError::Config(format!("创建密钥库目录失败：{}", e)));
        }

        let mut index = self.load_index();

        // 同一把钥匙按指纹去重：重复导入不堆两份。来源变了就顺手更新来源
        // （密钥在磁盘上被挪过位置是常事），名字与 id 保持不变以免打断已有连接。
        if let Some(existing) = index
            .keys
            .iter_mut()
            .find(|k| k.fingerprint == fingerprint)
        {
            let mut changed = false;
            if let Some(origin) = origin_path {
                if existing.origin_path.as_deref() != Some(origin) {
                    existing.origin_path = Some(origin.to_string());
                    changed = true;
                }
            }
            let meta = existing.clone();
            if changed {
                self.save_index(&index)?;
            }
            return Ok(meta);
        }

        let id = Uuid::new_v4().simple().to_string();
        let master = master_key()?;
        let envelope = seal_envelope(&master, &id, text)?;
        write_private(&self.key_file_path(&id), &envelope)?;

        let meta = StoredKeyMeta {
            id,
            name: if name.trim().is_empty() {
                short_fingerprint(&fingerprint)
            } else {
                name.trim().to_string()
            },
            algorithm,
            fingerprint,
            encrypted,
            origin_path: origin_path.map(str::to_string),
            created_at: Utc::now(),
        };
        index.keys.push(meta.clone());
        self.save_index(&index)?;
        Ok(meta)
    }

    fn load_pem(&self, id: &str) -> Result<Zeroizing<String>, AppError> {
        let text = std::fs::read_to_string(self.key_file_path(id))
            .map_err(|_| missing_entry())?;
        let master = master_key()?;
        open_envelope(&master, id, &text)
    }

    fn rename(&self, id: &str, name: &str) -> Result<StoredKeyMeta, AppError> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(AppError::Config("密钥名字不能为空".into()));
        }
        let mut index = self.load_index();
        let slot = index
            .keys
            .iter_mut()
            .find(|k| k.id == id)
            .ok_or_else(missing_entry)?;
        slot.name = trimmed.to_string();
        let meta = slot.clone();
        self.save_index(&index)?;
        Ok(meta)
    }

    fn delete(&self, id: &str) -> Result<(), AppError> {
        let mut index = self.load_index();
        let before = index.keys.len();
        index.keys.retain(|k| k.id != id);
        if index.keys.len() == before {
            // 已经不在库里：按幂等成功处理（重复点删除不该报错）
            return Ok(());
        }
        // 先删密文，再落索引：反过来会留下"索引没了、密文还在"的孤儿文件，
        // 而孤儿文件会在下次重建索引时自己长回来
        match std::fs::remove_file(self.key_file_path(id)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(AppError::Config(format!(
                    "删除密钥文件失败：{}（密钥仍在库里，可以重试）",
                    e
                )));
            }
        }
        self.save_index(&index)
    }

    fn origin_status(&self, id: &str) -> Result<Option<OriginStatus>, AppError> {
        let meta = self
            .load_index()
            .keys
            .into_iter()
            .find(|k| k.id == id)
            .ok_or_else(missing_entry)?;
        let Some(origin_path) = meta.origin_path.clone() else {
            return Ok(None);
        };

        let text = match key_material::read_key_file(&origin_path) {
            Ok(text) => text,
            Err(AppError::KeyAuth {
                code: KeyAuthCode::KeyNotFound,
                ..
            }) => {
                return Ok(Some(OriginStatus {
                    origin_path,
                    missing: true,
                    changed: false,
                }))
            }
            // 原文件读不了（权限等）不该报错打断列表：当作"暂时查不了"
            Err(_) => return Ok(None),
        };

        let stored = self.load_pem(id)?;
        // 库里那份可能是加密的：这一层拿不到它的 passphrase，所以只比公开部分
        // ——加密私钥的公开部分同样是明文，身份照样认得出来。
        let same = match (
            public_fingerprint(&text),
            public_fingerprint(stored.as_str()),
        ) {
            (Some(from_origin), Some(from_store)) => from_origin == from_store,
            _ => true, // 认不出来就别乱报"变了"
        };

        Ok(Some(OriginStatus {
            origin_path,
            missing: false,
            changed: !same,
        }))
    }

    fn replace_from_origin(
        &self,
        id: &str,
        passphrase: Option<&str>,
    ) -> Result<Option<StoredKeyMeta>, AppError> {
        let mut index = self.load_index();
        let slot = index
            .keys
            .iter()
            .position(|k| k.id == id)
            .ok_or_else(missing_entry)?;
        let Some(origin_path) = index.keys[slot].origin_path.clone() else {
            return Ok(None);
        };

        let text = key_material::read_key_file(&origin_path)?;
        let key = key_material::decode_pem(&text, passphrase)?;
        let master = master_key()?;
        let envelope = seal_envelope(&master, id, &text)?;
        write_private(&self.key_file_path(id), &envelope)?;

        // 名字保持不变（那是用户起的、和内容无关）；身份信息跟着新内容走
        let meta = &mut index.keys[slot];
        meta.algorithm = key.algorithm().to_string();
        meta.fingerprint = key.fingerprint(russh::keys::HashAlg::Sha256).to_string();
        meta.encrypted = key_material::is_encrypted(&text);
        let meta = meta.clone();
        self.save_index(&index)?;
        Ok(Some(meta))
    }
}

/// 名字缺省值：把 `SHA256:AbCd…` 变成一小段可辨认的前缀。
fn short_fingerprint(fingerprint: &str) -> String {
    let digest = fingerprint
        .split_once(':')
        .map(|(_, rest)| rest)
        .unwrap_or(fingerprint);
    format!("密钥 {}", digest.chars().take(8).collect::<String>())
}

/// 只靠密文内容重建一条元数据（索引丢失时用）。
///
/// 加密的 OpenSSH 私钥解不开正文，但它的公开部分仍是明文——身份（指纹）认得出来，
/// 足以把条目恢复成"一把需要密码的密钥"。PKCS#8 加密私钥没有这个便利，
/// 那类只能放弃恢复（记一条日志），文件本身仍在。
fn rebuild_meta(id: &str, pem: &str) -> Option<StoredKeyMeta> {
    if let Ok(key) = key_material::decode_pem(pem, None) {
        return Some(meta_from_key(id, &key, key_material::is_encrypted(pem)));
    }
    if let Ok(key) = russh::keys::ssh_key::PrivateKey::from_openssh(pem) {
        return Some(meta_from_key(id, &key, true));
    }
    None
}

fn meta_from_key(id: &str, key: &russh::keys::PrivateKey, encrypted: bool) -> StoredKeyMeta {
    let fingerprint = key.fingerprint(russh::keys::HashAlg::Sha256).to_string();
    StoredKeyMeta {
        id: id.to_string(),
        name: short_fingerprint(&fingerprint),
        algorithm: key.algorithm().to_string(),
        fingerprint,
        encrypted,
        origin_path: None,
        created_at: Utc::now(),
    }
}

// ── 主密钥与封装 ────────────────────────────────────────────────────────────

/// 测试专用的主密钥注入口：让密钥库的单测不必依赖系统密钥链。
#[cfg(test)]
static TEST_MASTER_KEY: OnceLock<[u8; 32]> = OnceLock::new();

/// 取主密钥，没有就现生成一把存进系统密钥链。
fn master_key() -> Result<Zeroizing<[u8; 32]>, AppError> {
    #[cfg(test)]
    if let Some(key) = TEST_MASTER_KEY.get() {
        return Ok(Zeroizing::new(*key));
    }

    // 串行化：并发导入时若两处同时判定"还没有主密钥"，后写的那把会覆盖先写的，
    // 先写那把加密出来的密文就再也解不开了
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().map_err(|_| {
        AppError::Config("密钥库主密钥锁已损坏，请重启应用".into())
    })?;

    if let Some(encoded) = keychain::get_password(MASTER_KEY_ACCOUNT)? {
        let bytes = B64.decode(encoded.trim()).map_err(|_| {
            AppError::Config("本地密钥库的主密钥格式不正确，已导入的私钥无法解密".into())
        })?;
        let key: [u8; 32] = bytes.try_into().map_err(|_| {
            AppError::Config("本地密钥库的主密钥长度不正确，已导入的私钥无法解密".into())
        })?;
        return Ok(Zeroizing::new(key));
    }

    let generated = Aes256Gcm::generate_key(OsRng);
    let mut key = [0u8; 32];
    key.copy_from_slice(&generated);
    keychain::save_password(MASTER_KEY_ACCOUNT, &B64.encode(key))?;
    Ok(Zeroizing::new(key))
}

/// 用 `id` 作为附加认证数据：密文与它所属的条目绑定，
/// 交换两个密文文件不会变成"用错了钥匙却毫无察觉"。
fn seal_envelope(master: &[u8; 32], id: &str, plaintext: &str) -> Result<String, AppError> {
    let cipher = Aes256Gcm::new_from_slice(master)
        .map_err(|_| AppError::Config("密钥库主密钥无效".into()))?;
    let nonce = Aes256Gcm::generate_nonce(OsRng);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext.as_bytes(),
                aad: id.as_bytes(),
            },
        )
        .map_err(|_| AppError::Config("加密私钥失败".into()))?;
    let envelope = Envelope {
        v: ENVELOPE_VERSION,
        nonce: B64.encode(nonce),
        ct: B64.encode(ciphertext),
    };
    serde_json::to_string(&envelope)
        .map_err(|e| AppError::Config(format!("序列化密钥封装失败：{}", e)))
}

fn open_envelope(
    master: &[u8; 32],
    id: &str,
    envelope_text: &str,
) -> Result<Zeroizing<String>, AppError> {
    let envelope: Envelope = serde_json::from_str(envelope_text).map_err(|_| undecryptable())?;
    if envelope.v != ENVELOPE_VERSION {
        return Err(AppError::KeyAuth {
            code: KeyAuthCode::KeyMissingFromStore,
            message: format!(
                "这把密钥是用更新版本的应用导入的（格式 v{}），当前版本读不了",
                envelope.v
            ),
        });
    }
    let nonce = B64.decode(envelope.nonce.as_bytes()).map_err(|_| undecryptable())?;
    let ciphertext = B64.decode(envelope.ct.as_bytes()).map_err(|_| undecryptable())?;
    let cipher =
        Aes256Gcm::new_from_slice(master).map_err(|_| AppError::Config("密钥库主密钥无效".into()))?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: id.as_bytes(),
            },
        )
        .map_err(|_| undecryptable())?;
    let text = String::from_utf8(plaintext).map_err(|_| undecryptable())?;
    Ok(Zeroizing::new(text))
}

/// 写私钥密文：unix 下建文件时就带 0600，别先建好再改权限（中间有个窗口）。
fn write_private(path: &Path, content: &str) -> Result<(), AppError> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| AppError::Config(format!("写入密钥文件失败：{}", e)))?;
    file.write_all(content.as_bytes())
        .map_err(|e| AppError::Config(format!("写入密钥文件失败：{}", e)))?;
    file.sync_all()
        .map_err(|e| AppError::Config(format!("写入密钥文件失败：{}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::key_material::tests::key_text;

    fn sample_key(passphrase: Option<&str>) -> String {
        key_text(7, passphrase)
    }

    /// 每个用例一个独立目录，并注入固定主密钥——单测不碰真实系统密钥链。
    fn fixture() -> (tempfile::TempDir, KeyStore) {
        let _ = TEST_MASTER_KEY.set([7u8; 32]);
        let dir = tempfile::tempdir().expect("tempdir");
        let store = KeyStore::new(dir.path().to_path_buf());
        (dir, store)
    }

    #[test]
    fn import_list_and_load_round_trip() {
        let (_dir, store) = fixture();
        let pem = sample_key(None);
        let meta = store
            .import_text(&pem, "公司跳板机", Some("/home/me/.ssh/id_ed25519"), None)
            .expect("import");

        assert_eq!(meta.name, "公司跳板机");
        assert_eq!(meta.algorithm, "ssh-ed25519");
        assert!(meta.fingerprint.starts_with("SHA256:"));
        assert!(!meta.encrypted);

        let listed = store.load_index().keys;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, meta.id);

        // 读回来的必须是原文，否则连接会失败
        let loaded = store.load_pem(&meta.id).expect("load");
        assert_eq!(loaded.as_str(), pem);
    }

    #[test]
    fn disk_holds_ciphertext_not_the_key() {
        let (_dir, store) = fixture();
        let pem = sample_key(None);
        let meta = store.import_text(&pem, "k", None, None).expect("import");

        let raw = std::fs::read_to_string(store.key_file_path(&meta.id)).expect("read");
        assert!(!raw.contains("BEGIN OPENSSH PRIVATE KEY"));
        assert!(!raw.contains("PRIVATE"));
        // 私钥正文的任何一段都不该出现在磁盘上
        let body: String = pem.lines().nth(1).unwrap_or("").to_string();
        assert!(!body.is_empty());
        assert!(!raw.contains(&body));
    }

    #[test]
    fn reimporting_the_same_key_does_not_create_a_second_entry() {
        let (_dir, store) = fixture();
        let pem = sample_key(None);
        let first = store
            .import_text(&pem, "A", Some("/old/path"), None)
            .expect("first");
        let again = store
            .import_text(&pem, "B", Some("/new/path"), None)
            .expect("second");

        assert_eq!(first.id, again.id, "同一把钥匙必须复用同一条目");
        assert_eq!(store.load_index().keys.len(), 1);
        // 名字保持不变（不打断已有连接），但来源更新到最新
        assert_eq!(again.name, "A");
        assert_eq!(again.origin_path.as_deref(), Some("/new/path"));
    }

    #[test]
    fn encrypted_key_keeps_its_encrypted_flag_and_requires_the_passphrase() {
        let (_dir, store) = fixture();
        let pem = sample_key(Some("pw"));

        // 不给密码：明确是"需要密码"，不是"格式坏"
        match store.import_text(&pem, "k", None, None).unwrap_err() {
            AppError::KeyAuth { code, .. } => assert_eq!(code, KeyAuthCode::NeedsPassphrase),
            other => panic!("unexpected: {other:?}"),
        }
        // 给错密码
        match store.import_text(&pem, "k", None, Some("bad")).unwrap_err() {
            AppError::KeyAuth { code, .. } => assert_eq!(code, KeyAuthCode::BadPassphrase),
            other => panic!("unexpected: {other:?}"),
        }
        // 给对密码：导入成功，且标记 encrypted，连接前就能据此决定要不要问密码
        let meta = store
            .import_text(&pem, "加密钥匙", None, Some("pw"))
            .expect("import");
        assert!(meta.encrypted);
        assert_eq!(store.load_pem(&meta.id).unwrap().as_str(), pem);
    }

    #[test]
    fn rename_and_delete_behave() {
        let (_dir, store) = fixture();
        let meta = store
            .import_text(&sample_key(None), "旧名", None, None)
            .expect("import");

        let renamed = store.rename(&meta.id, "新名").expect("rename");
        assert_eq!(renamed.name, "新名");
        assert_eq!(store.load_index().keys[0].name, "新名");

        store.delete(&meta.id).expect("delete");
        assert!(store.load_index().keys.is_empty());
        assert!(!store.key_file_path(&meta.id).exists());
        // 重复删除是幂等的
        store.delete(&meta.id).expect("delete twice");
    }

    #[test]
    fn deleting_an_unknown_id_is_a_no_op() {
        let (_dir, store) = fixture();
        store.delete("does-not-exist").expect("idempotent");
        assert!(store.load_index().keys.is_empty());
    }

    #[test]
    fn a_deleted_key_reports_a_clear_message_not_a_cryptic_one() {
        let (_dir, store) = fixture();
        match store.load_pem("gone").unwrap_err() {
            AppError::KeyAuth { code, message } => {
                assert_eq!(code, KeyAuthCode::KeyMissingFromStore);
                assert!(message.contains("已被删除"), "message was {message}");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn corrupt_ciphertext_says_reimport_instead_of_dumping_an_internal_error() {
        let (_dir, store) = fixture();
        let meta = store
            .import_text(&sample_key(None), "k", None, None)
            .expect("import");
        // 模拟"换了设备从备份恢复"：密文在，但主密钥已经不是那一把
        let file = store.key_file_path(&meta.id);
        let mut envelope: Envelope =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        envelope.ct = B64.encode(b"garbage-ciphertext");
        std::fs::write(&file, serde_json::to_string(&envelope).unwrap()).unwrap();

        match store.load_pem(&meta.id).unwrap_err() {
            AppError::KeyAuth { message, .. } => {
                assert!(message.contains("重新导入"), "message was {message}");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn swapping_two_envelopes_is_detected() {
        // 密文与条目 id 绑定（AAD），交换文件不该悄悄变成"用另一把钥匙"
        let (_dir, store) = fixture();
        let a = store
            .import_text(&key_text(8, None), "a", None, None)
            .unwrap();
        let b = store
            .import_text(&key_text(9, None), "b", None, None)
            .unwrap();
        assert_ne!(a.id, b.id, "两把不同的钥匙必须是两条记录");
        let a_bytes = std::fs::read_to_string(store.key_file_path(&a.id)).unwrap();
        let b_bytes = std::fs::read_to_string(store.key_file_path(&b.id)).unwrap();
        std::fs::write(store.key_file_path(&a.id), &b_bytes).unwrap();
        std::fs::write(store.key_file_path(&b.id), &a_bytes).unwrap();

        assert!(store.load_pem(&a.id).is_err());
        assert!(store.load_pem(&b.id).is_err());
    }

    #[test]
    fn missing_index_is_rebuilt_from_the_encrypted_files() {
        let (_dir, store) = fixture();
        let pem = sample_key(None);
        let meta = store.import_text(&pem, "重要密钥", None, None).expect("import");
        // 索引是"目录页"，不是数据本身；它没了不该表现成"密钥全没了"
        std::fs::remove_file(store.index_path()).unwrap();

        let rebuilt = store.load_index().keys;
        assert_eq!(rebuilt.len(), 1);
        assert_eq!(rebuilt[0].id, meta.id);
        assert_eq!(rebuilt[0].fingerprint, meta.fingerprint);
        assert_eq!(store.load_pem(&meta.id).unwrap().as_str(), pem);
    }

    #[test]
    fn corrupt_index_is_rebuilt_not_treated_as_empty() {
        let (_dir, store) = fixture();
        let meta = store
            .import_text(&sample_key(None), "k", None, None)
            .expect("import");
        std::fs::write(store.index_path(), "{ this is not json").unwrap();

        let rebuilt = store.load_index().keys;
        assert_eq!(rebuilt.len(), 1);
        assert_eq!(rebuilt[0].id, meta.id);
    }

    #[test]
    fn rebuilt_entries_fall_back_to_a_readable_default_name() {
        let (_dir, store) = fixture();
        store
            .import_text(&sample_key(None), "", None, None)
            .expect("import");
        assert!(store.load_index().keys[0].name.starts_with("密钥 "));
    }

    #[test]
    fn oversized_input_is_rejected_before_parsing() {
        let (_dir, store) = fixture();
        let huge = "A".repeat(key_material::MAX_KEY_BYTES + 1);
        match store.import_text(&huge, "k", None, None).unwrap_err() {
            AppError::KeyAuth { code, .. } => assert_eq!(code, KeyAuthCode::UnsupportedKey),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn resolve_without_any_source_tells_the_user_what_to_do() {
        // 两个来源都空：给的必须是"去选一把"，而不是内部错误
        match resolve_pem(Some(""), None).unwrap_err() {
            AppError::KeyAuth { code, message } => {
                assert_eq!(code, KeyAuthCode::KeyMissingFromStore);
                assert!(message.contains("选择或导入"), "message was {message}");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn tilde_paths_are_resolved_when_reading_a_legacy_key_path() {
        // 老数据里照抄占位符存下来的 "~/.ssh/id_rsa" 必须能真正读到家目录
        let err = resolve_pem(None, Some("~/.ssh/definitely-not-a-real-key-file")).unwrap_err();
        match err {
            AppError::KeyAuth { code, message } => {
                assert_eq!(code, KeyAuthCode::KeyNotFound);
                assert!(
                    !message.contains('~'),
                    "报错里应给出展开后的真实路径，实际是 {message}"
                );
                assert!(message.contains("不存在"), "message was {message}");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    // ── 导入来源的现状（堵"换了密钥却静默用旧的"） ──────────────────────────

    /// 在临时目录里放一个"用户的密钥文件"并导入它。
    fn import_from_file(
        dir: &tempfile::TempDir,
        store: &KeyStore,
        file_name: &str,
        pem: &str,
    ) -> (String, std::path::PathBuf) {
        let path = dir.path().join(file_name);
        std::fs::write(&path, pem).unwrap();
        let meta = store
            .import_text(pem, "", Some(path.to_str().unwrap()), None)
            .expect("import");
        (meta.id, path)
    }

    #[test]
    fn origin_status_is_quiet_when_the_source_is_unchanged() {
        let (dir, store) = fixture();
        let (id, _path) = import_from_file(&dir, &store, "id_ed25519", &key_text(11, None));

        let status = store.origin_status(&id).unwrap().expect("有来源");
        assert!(!status.missing);
        assert!(!status.changed, "原文件没变不该报变更");
    }

    #[test]
    fn origin_status_flags_a_regenerated_key() {
        // 用户重新生成了密钥：库里那份已经是旧的，连接会被服务器拒绝，
        // 而他刚把新的公钥加到服务器上——这条就是让他看得见的
        let (dir, store) = fixture();
        let (id, path) = import_from_file(&dir, &store, "id_ed25519", &key_text(12, None));
        std::fs::write(&path, key_text(13, None)).unwrap();

        let status = store.origin_status(&id).unwrap().expect("有来源");
        assert!(!status.missing);
        assert!(status.changed, "换了密钥必须报变更");
    }

    #[test]
    fn origin_status_ignores_a_reformatted_copy_of_the_same_key() {
        // 同一把密钥换了加密 / 换了导出格式：指纹相同，不算变更（别吓用户）
        let (dir, store) = fixture();
        let plain = key_text(14, None);
        let (id, path) = import_from_file(&dir, &store, "id_ed25519", &plain);
        std::fs::write(&path, key_text(14, Some("pw"))).unwrap();

        let status = store.origin_status(&id).unwrap().expect("有来源");
        assert!(!status.changed, "同一把密钥换个形态不算变更");
    }

    #[test]
    fn origin_status_reports_a_missing_source_without_erroring() {
        let (dir, store) = fixture();
        let (id, path) = import_from_file(&dir, &store, "id_ed25519", &key_text(15, None));
        std::fs::remove_file(&path).unwrap();

        let status = store.origin_status(&id).unwrap().expect("有来源");
        assert!(status.missing);
        assert!(!status.changed);
        // 来源没了不影响库里那份继续可用
        assert!(store.load_pem(&id).is_ok());
    }

    #[test]
    fn origin_status_is_none_for_pasted_keys() {
        // 粘贴导入的没有来源可比，前端就不显示这一行
        let (_dir, store) = fixture();
        let meta = store
            .import_text(&key_text(16, None), "粘贴的", None, None)
            .unwrap();
        assert!(store.origin_status(&meta.id).unwrap().is_none());
    }

    #[test]
    fn origin_status_of_a_deleted_entry_says_it_is_gone() {
        let (_dir, store) = fixture();
        match store.origin_status("nope").unwrap_err() {
            AppError::KeyAuth { code, .. } => assert_eq!(code, KeyAuthCode::KeyMissingFromStore),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn refreshing_from_origin_replaces_in_place_so_connections_keep_working() {
        // 关键：更新必须**原地换**（同一个 id）。新开一个条目的话，连接仍旧指着
        // 旧钥匙——用户点了"更新"却发现没用，比不做这个功能更糟。
        let (dir, store) = fixture();
        let (id, path) = import_from_file(&dir, &store, "id_ed25519", &key_text(20, None));
        let before = store.load_index().keys[0].fingerprint.clone();

        std::fs::write(&path, key_text(21, None)).unwrap();
        let updated = store
            .replace_from_origin(&id, None)
            .unwrap()
            .expect("有来源可刷");

        assert_eq!(updated.id, id, "id 必须不变，否则连接会指回旧钥匙");
        assert_ne!(updated.fingerprint, before, "指纹要跟着新内容走");
        assert_eq!(store.load_index().keys.len(), 1);
        assert_eq!(
            store.load_pem(&id).unwrap().as_str(),
            key_text(21, None),
            "库里那份必须真的换成新内容"
        );
        // 换完之后不再是"已变更"
        assert!(!store.origin_status(&id).unwrap().unwrap().changed);
    }

    #[test]
    fn refreshing_keeps_the_name_the_user_chose() {
        let (dir, store) = fixture();
        let path = dir.path().join("id_ed25519");
        std::fs::write(&path, key_text(22, None)).unwrap();
        let meta = store
            .import_text(
                &key_text(22, None),
                "生产密钥",
                Some(path.to_str().unwrap()),
                None,
            )
            .unwrap();

        std::fs::write(&path, key_text(23, None)).unwrap();
        let updated = store.replace_from_origin(&meta.id, None).unwrap().unwrap();
        assert_eq!(updated.name, "生产密钥");
    }

    #[test]
    fn refreshing_an_encrypted_new_key_asks_for_its_passphrase() {
        let (dir, store) = fixture();
        let (id, path) = import_from_file(&dir, &store, "id_ed25519", &key_text(24, None));
        std::fs::write(&path, key_text(25, Some("pw"))).unwrap();

        match store.replace_from_origin(&id, None).unwrap_err() {
            AppError::KeyAuth { code, .. } => assert_eq!(code, KeyAuthCode::NeedsPassphrase),
            other => panic!("unexpected: {other:?}"),
        }
        match store.replace_from_origin(&id, Some("bad")).unwrap_err() {
            AppError::KeyAuth { code, .. } => assert_eq!(code, KeyAuthCode::BadPassphrase),
            other => panic!("unexpected: {other:?}"),
        }
        // 给对密码才真的换，并记下"这把带密码"
        let updated = store
            .replace_from_origin(&id, Some("pw"))
            .unwrap()
            .unwrap();
        assert!(updated.encrypted);
    }

    #[test]
    fn refreshing_a_pasted_key_is_a_no_op() {
        let (_dir, store) = fixture();
        let meta = store
            .import_text(&key_text(26, None), "粘贴的", None, None)
            .unwrap();
        assert!(store.replace_from_origin(&meta.id, None).unwrap().is_none());
    }

    #[test]
    fn refreshing_a_vanished_source_reports_the_real_reason() {
        let (dir, store) = fixture();
        let (id, path) = import_from_file(&dir, &store, "id_ed25519", &key_text(27, None));
        std::fs::remove_file(&path).unwrap();

        match store.replace_from_origin(&id, None).unwrap_err() {
            AppError::KeyAuth { code, .. } => assert_eq!(code, KeyAuthCode::KeyNotFound),
            other => panic!("unexpected: {other:?}"),
        }
    }
}
