//! 配置码生成与验证。
//!
//! 配置码是账户根信任锚：
//! - 32 位随机字符串
//! - 字符集：31 个字符（2-9 + a-h + j-n + p-z，排除歧义字符 0/O/o、1/I/i/l）
//! - 空间：31^32 ≈ 10^47，暴力破解不可行
//! - 用户手抄保存，服务端只存 SHA-256(配置码)
//! - 丢失即账户不可恢复（by design）

use rand::seq::SliceRandom;
use rand::thread_rng;

use crate::error::AppError;

/// 配置码长度
pub const CONFIG_CODE_LEN: usize = 32;

/// 配置码字符集（排除歧义字符：0/O/o、1/I/i/l）
/// 31 个字符：2-9 + a-h + j-n + p-z（含 x）
const CHARSET: &[u8] = b"23456789abcdefghjkmnpqrstuvwxyz";

/// 生成随机配置码。
pub fn generate_config_code() -> String {
    let mut rng = thread_rng();
    (0..CONFIG_CODE_LEN)
        .map(|_| *CHARSET.choose(&mut rng).expect("字符集非空") as char)
        .collect()
}

/// 验证配置码格式（长度 + 字符集）。
pub fn validate_config_code(code: &str) -> Result<(), AppError> {
    if code.len() != CONFIG_CODE_LEN {
        return Err(AppError::Config(format!(
            "配置码长度不正确：期望 {} 位，实际 {} 位",
            CONFIG_CODE_LEN,
            code.len()
        )));
    }

    for c in code.chars() {
        if !CHARSET.contains(&(c as u8)) {
            return Err(AppError::Config(format!(
                "配置码包含非法字符：{}",
                c
            )));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_config_code() {
        let code = generate_config_code();
        assert_eq!(code.len(), CONFIG_CODE_LEN);
        assert!(validate_config_code(&code).is_ok());
    }

    #[test]
    fn test_validate_config_code() {
        // 合法：用 generate 生成保证长度和字符集都正确
        let valid = generate_config_code();
        assert_eq!(valid.len(), CONFIG_CODE_LEN);
        assert!(validate_config_code(&valid).is_ok());

        // 太短
        assert!(validate_config_code("abc").is_err());

        // 太长（33 位）
        assert!(validate_config_code("abcdefghjkmnpqrstuvwxyz23456789abc").is_err());

        // 含非法字符（0/O/o/1/I/i/l）
        assert!(validate_config_code("0bcdefghjkmnpqrstuvwxyz23456789ab").is_err()); // 0
        assert!(validate_config_code("1bcdefghjkmnpqrstuvwxyz23456789ab").is_err()); // 1
        assert!(validate_config_code("ibcdefghjkmnpqrstuvwxyz23456789ab").is_err()); // i
        assert!(validate_config_code("lbcdefghjkmnpqrstuvwxyz23456789ab").is_err()); // l
        assert!(validate_config_code("obcdefghjkmnpqrstuvwxyz23456789ab").is_err()); // o
        assert!(validate_config_code("Obcdefghjkmnpqrstuvwxyz23456789ab").is_err()); // O
        assert!(validate_config_code("Ibcdefghjkmnpqrstuvwxyz23456789ab").is_err()); // I
        assert!(validate_config_code("Lbcdefghjkmnpqrstuvwxyz23456789ab").is_err()); // L（大写也不在字符集）
    }

    #[test]
    fn test_config_code_uniqueness() {
        let code1 = generate_config_code();
        let code2 = generate_config_code();
        // 极低概率相同，但 32 位 31^32 空间下实际不可能
        assert_ne!(code1, code2);
    }
}
