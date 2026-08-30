use std::error::Error as StdError;

use crate::error::AppError;

/// 请求生命周期阶段
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestPhase {
    /// 首包到达前（建连、握手、等待 HTTP 状态码与首个流式数据分块）
    Probing,
    /// 首包已到达，正在流式接收与消费数据
    Streaming,
}

/// LLM 结构化错误
#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    /// HTTP 错误（保留原生的状态码、响应体）
    #[error("LLM 返回错误 {status}: {body}")]
    HttpStatus { status: u16, body: String },

    /// 首字超时 / 读取流式响应超时
    #[error("LLM 超时: {detail}")]
    Timeout { detail: String },

    /// 网络传输与连接错误
    #[error("LLM 网络连接失败: {0}")]
    Network(String),

    /// 连续数据解析失败
    #[error("LLM 流式响应解析失败: {0}")]
    ParseError(String),

    /// 用户取消
    #[error("LLM 请求已取消")]
    Cancelled,

    /// 客户端配置/参数错误
    #[error("LLM 配置错误: {0}")]
    Config(String),
}

impl LlmError {
    /// 判断在指定生命周期阶段下该错误是否可重试：
    /// 1. 若首包已到达（Streaming 阶段），为保证上游 session 安全与前端一致性，绝对不重试。
    /// 2. 若首包未到达（Probing 阶段）：
    ///    - HTTP 状态码匹配配置中的重试状态码（如 408, 429, 500-599）则重试。
    ///    - 超时错误受 `retry_on_timeout` 控制。
    ///    - 网络连接故障（如服务器拒绝/不可达）可重试。
    ///    - 其它（配置错误、解析错误、主动取消）不可重试。
    pub fn is_retryable(
        &self,
        phase: RequestPhase,
        conditions: &[RetryCondition],
        retry_on_timeout: bool,
    ) -> bool {
        if phase == RequestPhase::Streaming {
            return false;
        }

        match self {
            LlmError::HttpStatus { status, .. } => status_matches_conditions(*status, conditions),
            LlmError::Timeout { .. } => retry_on_timeout,
            LlmError::Network(_) => true,
            LlmError::ParseError(_) => false,
            LlmError::Cancelled => false,
            LlmError::Config(_) => false,
        }
    }
}

impl From<LlmError> for AppError {
    fn from(err: LlmError) -> Self {
        match err {
            LlmError::Cancelled => AppError::Cancelled("LLM 请求已取消".into()),
            LlmError::Config(msg) => AppError::Config(msg),
            other => AppError::Llm(other.to_string()),
        }
    }
}

/// A single entry in the retry conditions list: either a single status code or a range.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RetryCondition {
    Code(u16),
    Range(u16, u16),
}

/// Parse a comma-separated list of HTTP status codes/ranges.
/// Examples: "429" → [Code(429)], "500-599" → [Range(500,599)], "408, 429, 500-599" → mixed.
pub fn parse_retry_conditions(input: &str) -> Vec<RetryCondition> {
    let mut conditions = Vec::new();
    for entry in input.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        if let Some((lo, hi)) = entry.split_once('-') {
            match (lo.trim().parse::<u16>(), hi.trim().parse::<u16>()) {
                (Ok(lo), Ok(hi)) => {
                    let (lo, hi) = if lo <= hi { (lo, hi) } else { (hi, lo) };
                    conditions.push(RetryCondition::Range(lo, hi));
                }
                _ => log::warn!("忽略无效的重试范围配置: \"{}\"", entry),
            }
        } else if let Ok(code) = entry.parse::<u16>() {
            conditions.push(RetryCondition::Code(code));
        } else {
            log::warn!("忽略无效的重试状态码配置: \"{}\"", entry);
        }
    }
    conditions
}

/// Validate the retry conditions string. Returns an error message on invalid format.
pub fn validate_retry_conditions(input: &str) -> Result<(), String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    for entry in trimmed.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        if entry.contains('-') {
            let parts: Vec<&str> = entry.splitn(2, '-').collect();
            if parts.len() != 2 {
                return Err(format!("无效范围: \"{}\"（使用格式 lo-hi）", entry));
            }
            let lo: u16 = parts[0]
                .trim()
                .parse()
                .map_err(|_| format!("无法解析范围: \"{}\"", entry))?;
            let hi: u16 = parts[1]
                .trim()
                .parse()
                .map_err(|_| format!("无法解析范围: \"{}\"", entry))?;
            if lo < 100 || lo > 599 || hi < 100 || hi > 599 {
                return Err(format!("状态码超出范围 (100-599): \"{}\"", entry));
            }
            if hi < lo {
                return Err(format!("范围需从小到大: \"{}\"", entry));
            }
        } else {
            let code: u16 = entry
                .parse()
                .map_err(|_| format!("无效状态码: \"{}\"", entry))?;
            if code < 100 || code > 599 {
                return Err(format!("状态码超出范围 (100-599): \"{}\"", entry));
            }
        }
    }
    Ok(())
}

/// Check if a given HTTP status code matches any retry condition.
pub fn status_matches_conditions(status: u16, conditions: &[RetryCondition]) -> bool {
    conditions.iter().any(|c| match c {
        RetryCondition::Code(c) => status == *c,
        RetryCondition::Range(lo, hi) => status >= *lo && status <= *hi,
    })
}

/// 格式化 reqwest::Error 包含底层原因链
pub fn format_reqwest_error(err: &reqwest::Error) -> String {
    let mut parts: Vec<String> = vec![err.to_string()];
    let mut src: Option<&dyn StdError> = err.source();
    while let Some(e) = src {
        parts.push(format!("由: {}", e));
        src = e.source();
    }
    let category = if err.is_timeout() {
        Some("超时（网络不可达或服务器无响应）")
    } else if err.is_connect() {
        Some("连接失败（服务器拒绝/不存在/端口不通）")
    } else if err.is_request() {
        Some("请求构造失败")
    } else {
        None
    };
    if let Some(c) = category {
        parts.insert(0, format!("[{}]", c));
    }
    parts.join(" | ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_single_code() {
        let conditions = parse_retry_conditions("429");
        assert!(status_matches_conditions(429, &conditions));
        assert!(!status_matches_conditions(430, &conditions));
    }

    #[test]
    fn parse_range() {
        let conditions = parse_retry_conditions("500-599");
        assert!(status_matches_conditions(500, &conditions));
        assert!(status_matches_conditions(550, &conditions));
        assert!(status_matches_conditions(599, &conditions));
        assert!(!status_matches_conditions(499, &conditions));
        assert!(!status_matches_conditions(600, &conditions));
    }

    #[test]
    fn parse_mixed() {
        let conditions = parse_retry_conditions("408, 429, 500-599");
        assert!(status_matches_conditions(408, &conditions));
        assert!(status_matches_conditions(429, &conditions));
        assert!(status_matches_conditions(502, &conditions));
        assert!(!status_matches_conditions(400, &conditions));
        assert!(!status_matches_conditions(401, &conditions));
    }

    #[test]
    fn is_retryable_probing_vs_streaming() {
        let conditions = parse_retry_conditions("429, 500-599");
        let http_err = LlmError::HttpStatus {
            status: 429,
            body: "rate limited".into(),
        };
        // Probing 阶段可重试
        assert!(http_err.is_retryable(RequestPhase::Probing, &conditions, true));
        // Streaming 阶段严禁重试
        assert!(!http_err.is_retryable(RequestPhase::Streaming, &conditions, true));

        let timeout_err = LlmError::Timeout {
            detail: "首字超时".into(),
        };
        assert!(timeout_err.is_retryable(RequestPhase::Probing, &conditions, true));
        assert!(!timeout_err.is_retryable(RequestPhase::Probing, &conditions, false));
        assert!(!timeout_err.is_retryable(RequestPhase::Streaming, &conditions, true));
    }

    #[test]
    fn validate_retry_conditions_rules() {
        assert!(validate_retry_conditions("").is_ok());
        assert!(validate_retry_conditions("429").is_ok());
        assert!(validate_retry_conditions("500-599").is_ok());
        assert!(validate_retry_conditions("408, 429, 500-599").is_ok());
        assert!(validate_retry_conditions("abc").is_err());
        assert!(validate_retry_conditions("99").is_err());
        assert!(validate_retry_conditions("600").is_err());
        assert!(validate_retry_conditions("500-400").is_err());
    }
}
