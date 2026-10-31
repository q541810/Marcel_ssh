//! 同步的端到端加密：恢复密钥 → KEK → 数据密钥 DK → 文件密文信封。
//!
//! 层次（密钥只存在于用户自己的设备上，存储端看到的只有密文）：
//! - **恢复密钥 RK**：32 个字符、约 158 bit 熵的随机串，用户抄下来保管，也是「加入」时唯一要输入的东西；
//! - **KEK** = HKDF-SHA256(RK, salt, `marcel-sync-kek-v1`)。RK 本身就是高熵随机串，不需要慢哈希；
//! - **数据密钥 DK**：32 字节随机，真正加密所有文件。`meta.wrappedKey` 是用 KEK 包裹的 DK——
//!   这样将来换 RK 只需重新包裹 DK，不用重写所有数据；
//! - **信封**：`MSYNC` + 版本 + nonce + AES-256-GCM(deflate(明文 JSON))，AAD 绑定
//!   「文件类型 | 设备 id | seq」，把文件挪个位置冒充会解不开。
//!
//! 所有密钥类型：`Debug` 不输出内容、`Drop` 时清零；错误文案不含任何密钥材料。

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

/// 恢复密钥字符数。
pub const RK_LEN: usize = 32;
/// 恢复密钥字符集：去掉易混的 `0 1 i l o`，共 31 个字符，32 位 ≈ 158.5 bit。
pub const RK_ALPHABET: &[u8; 31] = b"23456789abcdefghjkmnpqrstuvwxyz";

const KEK_INFO: &[u8] = b"marcel-sync-kek-v1";
const META_AAD: &[u8] = b"marcel-sync-meta-v1";
/// 机密流子密钥的 HKDF info（定稿，改一个字 = 所有已同步的机密解不开）。
pub const SECRET_KEY_INFO: &[u8] = b"marcel-sync-secrets-v1";
/// 盐长度（字节）。
pub const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

pub const ENVELOPE_MAGIC: &[u8; 5] = b"MSYNC";
pub const ENVELOPE_VERSION: u8 = 1;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CryptoError {
    #[error("恢复密钥格式不对：应为 32 位字母数字（可用 - 分组，不区分大小写）")]
    InvalidRecoveryKey,
    #[error("恢复密钥不对，无法解开云端数据")]
    WrongKey,
    #[error("同步文件格式不正确（不是本应用写入的密文）")]
    BadEnvelope,
    /// 信封版本比本版本支持的新：需要升级应用。
    #[error("同步文件使用了更新的加密格式（v{0}），请升级应用")]
    EnvelopeTooNew(u8),
    #[error("同步文件解密失败：文件已损坏、被改动，或不属于这份同步数据")]
    Decrypt,
    #[error("压缩 / 解压同步数据失败")]
    Compression,
    #[error("系统随机数不可用")]
    Random,
    #[error("密钥数据无效")]
    InvalidKey,
}

fn fill_random(buf: &mut [u8]) -> Result<(), CryptoError> {
    OsRng.try_fill_bytes(buf).map_err(|_| CryptoError::Random)
}

// ---------------------------------------------------------------------------
// 恢复密钥
// ---------------------------------------------------------------------------

/// 恢复密钥。内部存规范形式（32 个小写字符，无分隔符）。
#[derive(Clone, PartialEq, Eq)]
pub struct RecoveryKey(Zeroizing<String>);

impl std::fmt::Debug for RecoveryKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RecoveryKey(<redacted>)")
    }
}

impl RecoveryKey {
    /// 生成新的恢复密钥（拒绝采样，字符均匀分布，无取模偏差）。
    pub fn generate() -> Result<Self, CryptoError> {
        let n = RK_ALPHABET.len() as u16;
        // 256 以内最大的 31 的倍数；落在它之上的字节丢弃重抽
        let limit = (256 / n) * n;
        let mut out = Zeroizing::new(String::with_capacity(RK_LEN));
        let mut buf = Zeroizing::new([0u8; 64]);
        while out.len() < RK_LEN {
            fill_random(&mut buf[..])?;
            for &b in buf.iter() {
                if (b as u16) < limit {
                    out.push(RK_ALPHABET[(b as u16 % n) as usize] as char);
                    if out.len() == RK_LEN {
                        break;
                    }
                }
            }
        }
        Ok(RecoveryKey(out))
    }

    /// 解析用户输入：忽略 `-` 与空白、不区分大小写；必须恰好 32 个合法字符。
    pub fn parse(input: &str) -> Result<Self, CryptoError> {
        let mut s = Zeroizing::new(String::with_capacity(RK_LEN));
        for c in input.chars() {
            if c == '-' || c.is_whitespace() {
                continue;
            }
            if !c.is_ascii() {
                return Err(CryptoError::InvalidRecoveryKey);
            }
            let c = c.to_ascii_lowercase();
            if !RK_ALPHABET.contains(&(c as u8)) {
                return Err(CryptoError::InvalidRecoveryKey);
            }
            if s.len() == RK_LEN {
                return Err(CryptoError::InvalidRecoveryKey); // 太长
            }
            s.push(c);
        }
        if s.len() != RK_LEN {
            return Err(CryptoError::InvalidRecoveryKey);
        }
        Ok(RecoveryKey(s))
    }

    /// 给用户看的形式：4 个一组、`-` 连接。
    pub fn display(&self) -> Zeroizing<String> {
        let mut out = Zeroizing::new(String::with_capacity(RK_LEN + RK_LEN / 4));
        for (i, c) in self.0.chars().enumerate() {
            if i > 0 && i % 4 == 0 {
                out.push('-');
            }
            out.push(c);
        }
        out
    }

    /// 规范形式（无分隔符）。存密钥链、放进同步码用这个。
    pub fn canonical(&self) -> &str {
        &self.0
    }
}

// ---------------------------------------------------------------------------
// 数据密钥
// ---------------------------------------------------------------------------

/// 数据密钥 DK（32 字节）。
#[derive(Clone, PartialEq, Eq)]
pub struct DataKey(Zeroizing<[u8; 32]>);

impl std::fmt::Debug for DataKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DataKey(<redacted>)")
    }
}

impl DataKey {
    pub fn generate() -> Result<Self, CryptoError> {
        let mut k = Zeroizing::new([0u8; 32]);
        fill_random(&mut k[..])?;
        Ok(DataKey(k))
    }

    pub fn from_bytes(b: &[u8]) -> Result<Self, CryptoError> {
        let arr: [u8; 32] = b.try_into().map_err(|_| CryptoError::InvalidKey)?;
        Ok(DataKey(Zeroizing::new(arr)))
    }

    /// 存密钥链用的文本形式（base64）。
    /// 原始字节（HMAC 这类「需要把 DK 当密钥用」的地方用）。
    ///
    /// 只给 crate 内、且只给**不泄露**的用途（HMAC 输入、派生）。外面想拿字节一律走
    /// `to_b64` 或派生函数。
    pub fn secret_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_b64(&self) -> Zeroizing<String> {
        Zeroizing::new(B64.encode(&self.0[..]))
    }

    pub fn from_b64(s: &str) -> Result<Self, CryptoError> {
        let bytes = Zeroizing::new(B64.decode(s.trim()).map_err(|_| CryptoError::InvalidKey)?);
        Self::from_bytes(&bytes)
    }

    fn cipher(&self) -> Aes256Gcm {
        // 长度恒为 32，不会失败
        Aes256Gcm::new_from_slice(&self.0[..]).expect("32 字节密钥")
    }

    /// 机密流的子密钥 `SK = HKDF-SHA256(DK, salt=空, info="marcel-sync-secrets-v1")`。
    ///
    /// 为什么要派生而不是直接用 DK：域分离。机密流单独一把钥匙，将来给机密加「额外口令」
    /// 只需换 SK 的派生输入，不用动远端文件格式，也不影响配置流的 DK。
    pub fn derive_secret_key(&self) -> Result<DataKey, CryptoError> {
        let hk = Hkdf::<Sha256>::new(None, &self.0[..]);
        let mut out = Zeroizing::new([0u8; 32]);
        hk.expand(SECRET_KEY_INFO, &mut out[..])
            .map_err(|_| CryptoError::InvalidKey)?;
        Ok(DataKey(out))
    }
}

/// 写进 `marcel-sync.json` 的密钥包裹信息（均为 base64）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WrappedKey {
    pub salt: String,
    pub wrapped_key: String,
}

/// 由 RK + 盐派生 KEK。
fn derive_kek(rk: &RecoveryKey, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let hk = Hkdf::<Sha256>::new(Some(salt), rk.canonical().as_bytes());
    let mut okm = Zeroizing::new([0u8; 32]);
    hk.expand(KEK_INFO, &mut okm[..])
        .map_err(|_| CryptoError::InvalidKey)?;
    Ok(okm)
}

fn kek_cipher(kek: &[u8; 32]) -> Aes256Gcm {
    Aes256Gcm::new_from_slice(kek).expect("32 字节密钥")
}

/// 新建一份同步的全套密钥：随机 RK、DK、盐，并把 DK 用 RK 派生的 KEK 包起来。
pub fn generate_vault() -> Result<(RecoveryKey, DataKey, WrappedKey), CryptoError> {
    let rk = RecoveryKey::generate()?;
    let dk = DataKey::generate()?;
    let wrapped = wrap_data_key(&rk, &dk)?;
    Ok((rk, dk, wrapped))
}

/// 用 RK 重新包裹已有的 DK（新盐）。将来「换恢复密钥」用。
pub fn wrap_data_key(rk: &RecoveryKey, dk: &DataKey) -> Result<WrappedKey, CryptoError> {
    let mut salt = [0u8; SALT_LEN];
    fill_random(&mut salt)?;
    let kek = derive_kek(rk, &salt)?;
    let mut nonce = [0u8; NONCE_LEN];
    fill_random(&mut nonce)?;
    let ct = kek_cipher(&kek)
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &dk.0[..],
                aad: META_AAD,
            },
        )
        .map_err(|_| CryptoError::InvalidKey)?;
    let mut blob = Vec::with_capacity(NONCE_LEN + ct.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    Ok(WrappedKey {
        salt: B64.encode(salt),
        wrapped_key: B64.encode(blob),
    })
}

/// 用 RK 解出 DK。RK 不对（或 meta 被改）→ [`CryptoError::WrongKey`]。
pub fn unwrap_data_key(
    rk: &RecoveryKey,
    salt_b64: &str,
    wrapped_b64: &str,
) -> Result<DataKey, CryptoError> {
    let salt = B64.decode(salt_b64).map_err(|_| CryptoError::WrongKey)?;
    let blob = B64.decode(wrapped_b64).map_err(|_| CryptoError::WrongKey)?;
    if blob.len() < NONCE_LEN + TAG_LEN {
        return Err(CryptoError::WrongKey);
    }
    let kek = derive_kek(rk, &salt)?;
    let (nonce, ct) = blob.split_at(NONCE_LEN);
    let pt = Zeroizing::new(
        kek_cipher(&kek)
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: ct,
                    aad: META_AAD,
                },
            )
            .map_err(|_| CryptoError::WrongKey)?,
    );
    DataKey::from_bytes(&pt).map_err(|_| CryptoError::WrongKey)
}

// ---------------------------------------------------------------------------
// 密文信封
// ---------------------------------------------------------------------------

/// 各条流的 AAD tag（**定稿**，见 `scratch/sync/PHASE2-3-CONTRACT.md` 第 2 节）。
///
/// 配置流沿用 [`FileKind::as_str`]，值永远是 `seg` / `snap`；二、三期新增的流各用各的 tag，
/// 这样一条流的文件被挪进另一条流会解不开（AAD 不匹配）。
pub mod aad_tag {
    /// 配置流 · 增量段（一期）。
    pub const CONFIG_SEG: &str = "seg";
    /// 配置流 · 快照（一期）。
    pub const CONFIG_SNAP: &str = "snap";
    /// 对话与记忆流 · 增量段。
    pub const CONV_SEG: &str = "conv-seg";
    /// 对话与记忆流 · 分包快照索引。
    pub const CONV_SNAP_INDEX: &str = "conv-snap-index";
    /// 对话与记忆流 · 分包快照的一个包。
    pub const CONV_SNAP_PART: &str = "conv-snap-part";
    /// 机密流 · 增量段。
    pub const SEC_SEG: &str = "sec-seg";
    /// 机密流 · 快照。
    pub const SEC_SNAP: &str = "sec-snap";
    /// 按内容寻址的大块（图片 / 私钥正文）。
    pub const BLOB: &str = "blob";
    /// 机密流的**本机镜像**（`sync/mirror/secrets.msync`，用 DK 封装的本地文件，不上传）。
    ///
    /// 它不经过网络，但同样要防「配置目录被整份端走」：和远端文件一样用 DK 加密，
    /// 而不是只靠文件权限。tag 单独一个，免得它被当成某个远端文件塞回去。
    pub const SEC_MIRROR: &str = "sec-mirror";
}

/// 远端文件的种类（进 AAD 与文件名）。**只用于配置流**；二、三期的流有各自的 tag 常量。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FileKind {
    /// 增量段：一批 op。
    Segment,
    /// 快照：完整镜像。
    Snapshot,
}

impl FileKind {
    /// 进 AAD 的 tag，也是文件名的前缀。配置流的历史值，**一个字都不能改**。
    pub fn as_str(self) -> &'static str {
        match self {
            FileKind::Segment => "seg",
            FileKind::Snapshot => "snap",
        }
    }
}

/// AAD 前缀的下半部分（tag 由各流自己定，见下）。格式定稿：`marcel-sync|<tag>|<device>|<seq>`。
///
/// tag 是**流 + 文件种类**的组合（`seg` / `snap` / `conv-seg` / `conv-snap-index` / …），
/// 这样把一条流的文件挪到另一条流、或把它改名成别的种类，都会在解密时露馅。
pub fn aad(aad_tag: &str, device_id: &str, seq: u64) -> Vec<u8> {
    format!("marcel-sync|{aad_tag}|{device_id}|{seq}").into_bytes()
}

/// 分包快照的 AAD：`marcel-sync|conv-snap-part|<device>|<seq>|<part>`（多一段分包号）。
pub fn aad_with_part(aad_tag: &str, device_id: &str, seq: u64, part: u32) -> Vec<u8> {
    format!("marcel-sync|{aad_tag}|{device_id}|{seq}|{part}").into_bytes()
}

/// 按内容寻址的大块（blob）的 AAD：`marcel-sync|blob|<device>|<name>`（用名字代替序号）。
pub fn aad_named(aad_tag: &str, device_id: &str, name: &str) -> Vec<u8> {
    format!("marcel-sync|{aad_tag}|{device_id}|{name}").into_bytes()
}

/// 把明文（通常是 JSON 字节）压缩 + 加密成信封。`aad_tag` 由调用方按流指定。
pub fn seal(
    dk: &DataKey,
    aad_tag: &str,
    device_id: &str,
    seq: u64,
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    seal_with_aad(dk, &aad(aad_tag, device_id, seq), plaintext)
}

/// 同 [`seal`]，但 AAD 由调用方整段给出（分包快照、blob 用）。
pub fn seal_with_aad(dk: &DataKey, aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    use flate2::write::DeflateEncoder;
    use flate2::Compression;
    use std::io::Write;

    let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
    enc.write_all(plaintext)
        .map_err(|_| CryptoError::Compression)?;
    let compressed = enc.finish().map_err(|_| CryptoError::Compression)?;

    let mut nonce = [0u8; NONCE_LEN];
    fill_random(&mut nonce)?;
    let ct = dk
        .cipher()
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &compressed,
                aad,
            },
        )
        .map_err(|_| CryptoError::Decrypt)?;

    let mut out = Vec::with_capacity(ENVELOPE_MAGIC.len() + 1 + NONCE_LEN + ct.len());
    out.extend_from_slice(ENVELOPE_MAGIC);
    out.push(ENVELOPE_VERSION);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// 解开信封，返回明文。
///
/// 解压不设大小上限：密文有 GCM 认证，能走到这一步说明内容来自持有 DK 的设备，
/// 不存在攻击者构造的压缩炸弹。
pub fn open(
    dk: &DataKey,
    aad_tag: &str,
    device_id: &str,
    seq: u64,
    envelope: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    open_with_aad(dk, &aad(aad_tag, device_id, seq), envelope)
}

/// 同 [`open`]，但 AAD 由调用方整段给出（分包快照、blob 用）。
pub fn open_with_aad(dk: &DataKey, aad: &[u8], envelope: &[u8]) -> Result<Vec<u8>, CryptoError> {
    use flate2::read::DeflateDecoder;
    use std::io::Read;

    let header = ENVELOPE_MAGIC.len() + 1;
    if envelope.len() < header + NONCE_LEN + TAG_LEN
        || &envelope[..ENVELOPE_MAGIC.len()] != ENVELOPE_MAGIC
    {
        return Err(CryptoError::BadEnvelope);
    }
    let version = envelope[ENVELOPE_MAGIC.len()];
    if version > ENVELOPE_VERSION {
        return Err(CryptoError::EnvelopeTooNew(version));
    }
    if version == 0 {
        return Err(CryptoError::BadEnvelope);
    }
    let (nonce, ct) = envelope[header..].split_at(NONCE_LEN);
    let compressed = dk
        .cipher()
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad })
        .map_err(|_| CryptoError::Decrypt)?;
    let mut out = Vec::new();
    DeflateDecoder::new(&compressed[..])
        .read_to_end(&mut out)
        .map_err(|_| CryptoError::Compression)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------------- 恢复密钥 ----------------

    #[test]
    fn alphabet_matches_spec() {
        assert_eq!(RK_ALPHABET.len(), 31);
        for bad in b"01ilo" {
            assert!(!RK_ALPHABET.contains(bad), "{}", *bad as char);
        }
        // 字符集内无重复
        let mut v = RK_ALPHABET.to_vec();
        v.sort();
        v.dedup();
        assert_eq!(v.len(), 31);
    }

    #[test]
    fn generated_keys_have_right_shape_and_differ() {
        let a = RecoveryKey::generate().unwrap();
        let b = RecoveryKey::generate().unwrap();
        assert_eq!(a.canonical().len(), RK_LEN);
        assert!(a.canonical().bytes().all(|c| RK_ALPHABET.contains(&c)));
        assert_ne!(a, b);
    }

    #[test]
    fn generated_keys_use_the_whole_alphabet_roughly_uniformly() {
        // 统计性检查：几千个字符里每个字符都应出现，且没有一个占比离谱
        let mut counts = [0usize; 31];
        for _ in 0..200 {
            let k = RecoveryKey::generate().unwrap();
            for c in k.canonical().bytes() {
                counts[RK_ALPHABET.iter().position(|a| *a == c).unwrap()] += 1;
            }
        }
        let total: usize = counts.iter().sum();
        assert_eq!(total, 200 * RK_LEN);
        let expected = total as f64 / 31.0;
        for (i, c) in counts.iter().enumerate() {
            assert!(
                (*c as f64) > expected * 0.7 && (*c as f64) < expected * 1.3,
                "字符 {} 出现 {c} 次，期望约 {expected}",
                RK_ALPHABET[i] as char
            );
        }
    }

    #[test]
    fn display_groups_of_four_and_parse_round_trip() {
        let k = RecoveryKey::generate().unwrap();
        let shown = k.display();
        let groups: Vec<&str> = shown.split('-').collect();
        assert_eq!(groups.len(), 8);
        assert!(groups.iter().all(|g| g.len() == 4));
        assert_eq!(RecoveryKey::parse(&shown).unwrap(), k);
    }

    #[test]
    fn parse_ignores_dashes_whitespace_and_case() {
        let k = RecoveryKey::parse("abcd-efgh-jkmn-pqrs-tuvw-xyz2-3456-789a").unwrap();
        assert_eq!(k.canonical(), "abcdefghjkmnpqrstuvwxyz23456789a");
        let same = RecoveryKey::parse("  ABCD efgh\tJKMN\npqrs-TUVW xyz2 3456 789A  ").unwrap();
        assert_eq!(k, same);
        assert_eq!(RecoveryKey::parse(k.canonical()).unwrap(), k);
    }

    #[test]
    fn parse_rejects_bad_input() {
        for bad in [
            "",
            "abcd",
            // 少一位 / 多一位
            "abcdefghjkmnpqrstuvwxyz23456789",
            "abcdefghjkmnpqrstuvwxyz23456789ab",
            // 含被排除的易混字符
            "abcdefghjkmnpqrstuvwxyz2345678o",
            "abcdefghjkmnpqrstuvwxyz2345678l",
            "abcdefghjkmnpqrstuvwxyz2345678i",
            "abcdefghjkmnpqrstuvwxyz23456780",
            "abcdefghjkmnpqrstuvwxyz23456781",
            // 非 ASCII
            "abcdefghjkmnpqrstuvwxyz2345678中",
            "abcdefghjkmnpqrstuvwxyz2345678!",
        ] {
            assert_eq!(
                RecoveryKey::parse(bad),
                Err(CryptoError::InvalidRecoveryKey),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn debug_output_never_contains_key_material() {
        let rk = RecoveryKey::generate().unwrap();
        let dk = DataKey::generate().unwrap();
        let s = format!("{rk:?} {dk:?}");
        assert!(!s.contains(rk.canonical()));
        assert!(s.contains("redacted"));
    }

    // ---------------- KEK / DK ----------------

    #[test]
    fn kek_derivation_is_deterministic_and_input_sensitive() {
        let rk = RecoveryKey::parse("abcdefghjkmnpqrstuvwxyz23456789a").unwrap();
        let rk2 = RecoveryKey::parse("abcdefghjkmnpqrstuvwxyz23456789b").unwrap();
        let salt = [7u8; SALT_LEN];
        let a = derive_kek(&rk, &salt).unwrap();
        let b = derive_kek(&rk, &salt).unwrap();
        assert_eq!(*a, *b);
        assert_ne!(*a, *derive_kek(&rk2, &salt).unwrap(), "不同 RK → 不同 KEK");
        assert_ne!(
            *a,
            *derive_kek(&rk, &[8u8; SALT_LEN]).unwrap(),
            "不同盐 → 不同 KEK"
        );
        // 钉住一个已知向量（用独立的 Python HMAC 实现按 RFC 5869 算出）：
        // 防止有人"顺手"改了 info 字符串或参数顺序，让旧数据全部解不开
        let hex: String = a.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex, "d66ed2827f45aef0d82be615da9b87bfdf53b5cb2af0fe3cd8300e5d388697da",
            "KEK 派生结果变了：这会让所有已存在的同步数据解不开"
        );
    }

    #[test]
    fn data_key_wrap_unwrap_round_trip() {
        let (rk, dk, wrapped) = generate_vault().unwrap();
        let back = unwrap_data_key(&rk, &wrapped.salt, &wrapped.wrapped_key).unwrap();
        assert_eq!(back, dk);
        // 通过显示形式重新解析 RK 也能解开
        let rk2 = RecoveryKey::parse(&rk.display()).unwrap();
        assert_eq!(
            unwrap_data_key(&rk2, &wrapped.salt, &wrapped.wrapped_key).unwrap(),
            dk
        );
    }

    #[test]
    fn wrong_recovery_key_fails_to_unwrap() {
        let (_rk, _dk, wrapped) = generate_vault().unwrap();
        let other = RecoveryKey::generate().unwrap();
        assert_eq!(
            unwrap_data_key(&other, &wrapped.salt, &wrapped.wrapped_key),
            Err(CryptoError::WrongKey)
        );
    }

    #[test]
    fn tampered_or_malformed_meta_fails_to_unwrap() {
        let (rk, _dk, wrapped) = generate_vault().unwrap();
        // 篡改包裹后的密钥
        let mut blob = B64.decode(&wrapped.wrapped_key).unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 1;
        assert_eq!(
            unwrap_data_key(&rk, &wrapped.salt, &B64.encode(&blob)),
            Err(CryptoError::WrongKey)
        );
        // 换盐
        assert_eq!(
            unwrap_data_key(&rk, &B64.encode([1u8; SALT_LEN]), &wrapped.wrapped_key),
            Err(CryptoError::WrongKey)
        );
        // 垃圾输入
        assert_eq!(
            unwrap_data_key(&rk, "!!!", &wrapped.wrapped_key),
            Err(CryptoError::WrongKey)
        );
        assert_eq!(
            unwrap_data_key(&rk, &wrapped.salt, "AAAA"),
            Err(CryptoError::WrongKey)
        );
    }

    #[test]
    fn rewrapping_uses_fresh_salt_and_same_dk() {
        let (rk, dk, w1) = generate_vault().unwrap();
        let w2 = wrap_data_key(&rk, &dk).unwrap();
        assert_ne!(w1.salt, w2.salt);
        assert_ne!(w1.wrapped_key, w2.wrapped_key);
        assert_eq!(unwrap_data_key(&rk, &w2.salt, &w2.wrapped_key).unwrap(), dk);
    }

    #[test]
    fn data_key_b64_round_trip() {
        let dk = DataKey::generate().unwrap();
        let s = dk.to_b64();
        assert_eq!(DataKey::from_b64(&s).unwrap(), dk);
        assert_eq!(
            DataKey::from_b64("not base64!"),
            Err(CryptoError::InvalidKey)
        );
        assert_eq!(DataKey::from_b64("AAAA"), Err(CryptoError::InvalidKey));
        assert_eq!(
            DataKey::from_bytes(&[0u8; 31]),
            Err(CryptoError::InvalidKey)
        );
    }

    /// 机密流的子密钥：钉死一个独立实现的已知向量，防止有人顺手改 info。
    ///
    /// 算法：RFC 5869 HKDF-SHA256，salt 缺省 = 32 字节 0，IKM = 字节 00..1f，info 见常量。
    /// 用 Python 独立算的（不经过本模块的任何代码）：
    /// ```text
    /// prk = HMAC-SHA256(b"\x00"*32, bytes(range(32)))
    /// t   = HMAC-SHA256(prk, info + b"\x01")
    /// okm = HMAC-SHA256(prk, t + info + b"\x02")
    /// ```
    #[test]
    fn secret_key_derivation_is_pinned_to_a_known_vector() {
        let dk = DataKey::from_bytes(&(0u8..32).collect::<Vec<u8>>()).unwrap();
        let sk = dk.derive_secret_key().unwrap();
        let hex: String = sk.0.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex, "0710431c33e85eb4f43ae171af568d36ff7bcc6434b2ced40573b60dd943c2d1",
            "SK 派生结果变了：这会让所有已同步的机密解不开"
        );
        // 确定性 + 与 DK 不同（域分离）
        assert_eq!(dk.derive_secret_key().unwrap(), sk);
        assert_ne!(sk, dk);
        assert_eq!(
            DataKey::from_bytes(&[0xab; 32])
                .unwrap()
                .derive_secret_key()
                .unwrap()
                .0
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>(),
            "0157635288d758c5b15331750e4f2979436f3a097cd8a0a46cc13917bb7c22b4"
        );
    }

    /// 配置流的 AAD 是**历史字面量**：改了就等于所有老设备读不懂新文件、新设备读不懂老文件。
    #[test]
    fn config_aad_is_byte_identical_to_phase_one() {
        assert_eq!(aad("seg", "d1", 7), b"marcel-sync|seg|d1|7");
        assert_eq!(aad("snap", "d1", 7), b"marcel-sync|snap|d1|7");
        assert_eq!(
            aad(FileKind::Segment.as_str(), "abc", 12),
            b"marcel-sync|seg|abc|12"
        );
        assert_eq!(
            aad(FileKind::Snapshot.as_str(), "abc", 40),
            b"marcel-sync|snap|abc|40"
        );
        // 契约里新增的 tag
        assert_eq!(aad("conv-seg", "d", 3), b"marcel-sync|conv-seg|d|3");
        assert_eq!(
            aad("conv-snap-index", "d", 3),
            b"marcel-sync|conv-snap-index|d|3"
        );
        assert_eq!(
            aad_with_part("conv-snap-part", "d", 3, 0),
            b"marcel-sync|conv-snap-part|d|3|0"
        );
        assert_eq!(aad("sec-seg", "d", 3), b"marcel-sync|sec-seg|d|3");
        assert_eq!(aad("sec-snap", "d", 3), b"marcel-sync|sec-snap|d|3");
        assert_eq!(aad_named("blob", "d", "00ff"), b"marcel-sync|blob|d|00ff");
    }

    /// 跨流的 AAD 串流：把一条流的文件当另一条流读必须解不开。
    #[test]
    fn cross_stream_aad_does_not_decrypt() {
        let dk = key();
        let env = seal(&dk, aad_tag::CONV_SEG, "d", 1, b"{\"x\":1}").unwrap();
        assert_eq!(
            open(&dk, aad_tag::SEC_SEG, "d", 1, &env),
            Err(CryptoError::Decrypt)
        );
        assert_eq!(
            open(&dk, aad_tag::CONFIG_SEG, "d", 1, &env),
            Err(CryptoError::Decrypt)
        );
        assert_eq!(
            open(&dk, aad_tag::CONV_SEG, "d", 2, &env),
            Err(CryptoError::Decrypt)
        );
        assert_eq!(
            open(&dk, aad_tag::CONV_SEG, "d", 1, &env).unwrap(),
            b"{\"x\":1}"
        );
        // 分包：分包号也在 AAD 里，换一个包号解不开
        let part = seal_with_aad(
            &dk,
            &aad_with_part(aad_tag::CONV_SNAP_PART, "d", 9, 1),
            b"part",
        )
        .unwrap();
        assert!(open_with_aad(
            &dk,
            &aad_with_part(aad_tag::CONV_SNAP_PART, "d", 9, 2),
            &part
        )
        .is_err());
        assert_eq!(
            open_with_aad(
                &dk,
                &aad_with_part(aad_tag::CONV_SNAP_PART, "d", 9, 1),
                &part
            )
            .unwrap(),
            b"part"
        );
    }

    /// 机密流用 SK、配置流用 DK：拿错钥匙解不开。
    #[test]
    fn secret_stream_key_is_not_the_data_key() {
        let dk = key();
        let sk = dk.derive_secret_key().unwrap();
        let env = seal(&sk, aad_tag::SEC_SEG, "d", 1, b"secret").unwrap();
        assert_eq!(
            open(&dk, aad_tag::SEC_SEG, "d", 1, &env),
            Err(CryptoError::Decrypt)
        );
        assert_eq!(
            open(&sk, aad_tag::SEC_SEG, "d", 1, &env).unwrap(),
            b"secret"
        );
    }

    // ---------------- 信封 ----------------

    fn key() -> DataKey {
        DataKey::generate().unwrap()
    }

    #[test]
    fn envelope_round_trip() {
        let dk = key();
        let msg = br#"{"format":1,"ops":[{"a":"b"}]}"#;
        let env = seal(&dk, FileKind::Segment.as_str(), "dev1", 12, msg).unwrap();
        assert_eq!(&env[..5], b"MSYNC");
        assert_eq!(env[5], 1);
        assert_eq!(
            open(&dk, FileKind::Segment.as_str(), "dev1", 12, &env).unwrap(),
            msg
        );
    }

    #[test]
    fn envelope_round_trip_empty_and_large_and_unicode() {
        let dk = key();
        for msg in [
            Vec::new(),
            "中文、emoji 🎉、\u{0}控制字符".as_bytes().to_vec(),
            vec![b'x'; 3_000_000],
            (0..200_000u32).flat_map(|i| i.to_le_bytes()).collect(),
        ] {
            let env = seal(&dk, FileKind::Snapshot.as_str(), "d", 1, &msg).unwrap();
            assert_eq!(
                open(&dk, FileKind::Snapshot.as_str(), "d", 1, &env).unwrap(),
                msg
            );
        }
    }

    #[test]
    fn envelope_compresses_repetitive_json() {
        let dk = key();
        let msg = "{\"k\":\"vvvvvvvvvvvvvvvv\"},".repeat(10_000);
        let env = seal(&dk, FileKind::Segment.as_str(), "d", 1, msg.as_bytes()).unwrap();
        assert!(env.len() < msg.len() / 10, "{} vs {}", env.len(), msg.len());
    }

    #[test]
    fn same_plaintext_seals_differently_each_time() {
        let dk = key();
        let a = seal(&dk, FileKind::Segment.as_str(), "d", 1, b"hello").unwrap();
        let b = seal(&dk, FileKind::Segment.as_str(), "d", 1, b"hello").unwrap();
        assert_ne!(a, b, "nonce 必须每次随机");
    }

    #[test]
    fn aad_mismatch_fails_to_decrypt() {
        let dk = key();
        let env = seal(&dk, FileKind::Segment.as_str(), "dev1", 12, b"secret").unwrap();
        // 文件被挪到别的设备目录 / 别的序号 / 换了类型：都解不开
        assert_eq!(
            open(&dk, FileKind::Segment.as_str(), "dev2", 12, &env),
            Err(CryptoError::Decrypt)
        );
        assert_eq!(
            open(&dk, FileKind::Segment.as_str(), "dev1", 13, &env),
            Err(CryptoError::Decrypt)
        );
        assert_eq!(
            open(&dk, FileKind::Snapshot.as_str(), "dev1", 12, &env),
            Err(CryptoError::Decrypt)
        );
    }

    #[test]
    fn wrong_data_key_fails_to_decrypt() {
        let env = seal(&key(), FileKind::Segment.as_str(), "d", 1, b"x").unwrap();
        assert_eq!(
            open(&key(), FileKind::Segment.as_str(), "d", 1, &env),
            Err(CryptoError::Decrypt)
        );
    }

    #[test]
    fn any_single_byte_tamper_is_rejected() {
        let dk = key();
        let env = seal(&dk, FileKind::Segment.as_str(), "d", 1, b"important config").unwrap();
        for i in 0..env.len() {
            let mut bad = env.clone();
            bad[i] ^= 0x01;
            assert!(
                open(&dk, FileKind::Segment.as_str(), "d", 1, &bad).is_err(),
                "篡改第 {i} 字节没有被发现"
            );
        }
    }

    #[test]
    fn truncated_or_foreign_files_are_rejected() {
        let dk = key();
        let env = seal(&dk, FileKind::Segment.as_str(), "d", 1, b"x").unwrap();
        assert!(open(
            &dk,
            FileKind::Segment.as_str(),
            "d",
            1,
            &env[..env.len() - 1]
        )
        .is_err());
        assert_eq!(
            open(&dk, FileKind::Segment.as_str(), "d", 1, &env[..10]),
            Err(CryptoError::BadEnvelope)
        );
        assert_eq!(
            open(
                &dk,
                FileKind::Segment.as_str(),
                "d",
                1,
                b"{\"json\": true, \"but\": \"not an envelope at all\"}"
            ),
            Err(CryptoError::BadEnvelope)
        );
        assert_eq!(
            open(&dk, FileKind::Segment.as_str(), "d", 1, b""),
            Err(CryptoError::BadEnvelope)
        );
    }

    #[test]
    fn newer_envelope_version_is_reported_as_too_new() {
        let dk = key();
        let mut env = seal(&dk, FileKind::Segment.as_str(), "d", 1, b"x").unwrap();
        env[5] = ENVELOPE_VERSION + 1;
        assert_eq!(
            open(&dk, FileKind::Segment.as_str(), "d", 1, &env),
            Err(CryptoError::EnvelopeTooNew(ENVELOPE_VERSION + 1))
        );
        env[5] = 0;
        assert_eq!(
            open(&dk, FileKind::Segment.as_str(), "d", 1, &env),
            Err(CryptoError::BadEnvelope)
        );
    }

    #[test]
    fn error_messages_do_not_leak_secrets() {
        let rk = RecoveryKey::generate().unwrap();
        let msgs = [
            CryptoError::InvalidRecoveryKey.to_string(),
            CryptoError::WrongKey.to_string(),
            CryptoError::Decrypt.to_string(),
        ];
        for m in msgs {
            assert!(!m.contains(rk.canonical()));
        }
    }
}
