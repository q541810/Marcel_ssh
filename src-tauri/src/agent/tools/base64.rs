//! Base64 encoding/decoding (RFC 4648 standard alphabet).
//!
//! Used by file-operation tools for binary-safe data transfer over SSH exec
//! channels, which are hostile to NUL bytes, EOF markers, and 8-bit data.

use crate::error::AppError;

/// Base64-encode bytes (no line wrap).
pub(crate) fn b64_encode(bytes: &[u8]) -> String {
    const ALPHA: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | (bytes[i + 2] as u32);
        out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 6) & 0x3f) as usize] as char);
        out.push(ALPHA[(n & 0x3f) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 6) & 0x3f) as usize] as char);
        out.push('=');
    }
    out
}

/// Decode standard-alphabet base64 (RFC 4648). Whitespace is ignored.
pub(crate) fn b64_decode(s: &str) -> Result<Vec<u8>, AppError> {
    let mut buf = [0u8; 4];
    let mut bi = 0;
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut pad = 0;
    for c in s.bytes() {
        let v: u8 = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => {
                pad += 1;
                buf[bi] = 0;
                bi += 1;
                if bi == 4 {
                    out.push((buf[0] << 2) | (buf[1] >> 4));
                    if pad < 2 {
                        out.push((buf[1] << 4) | (buf[2] >> 2));
                    }
                    bi = 0;
                }
                continue;
            }
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return Err(AppError::Agent(format!(
                "invalid base64 character: 0x{:02x}",
                c
            ))),
        };
        buf[bi] = v;
        bi += 1;
        if bi == 4 {
            out.push((buf[0] << 2) | (buf[1] >> 4));
            out.push((buf[1] << 4) | (buf[2] >> 2));
            out.push((buf[2] << 6) | buf[3]);
            bi = 0;
        }
    }
    if bi != 0 {
        return Err(AppError::Agent("truncated base64 input".into()));
    }
    Ok(out)
}

/// Build a portable shell command that base64-encodes a remote file to stdout.
/// Tries GNU `base64 -w0`, falls back to BSD `base64`, then `openssl base64 -A`.
pub(crate) fn cmd_encode_file(path_escaped: &str) -> String {
    format!(
        "(base64 -w0 {p} 2>/dev/null) || (base64 {p} 2>/dev/null | tr -d '\\n') || (openssl base64 -A -in {p} 2>/dev/null)",
        p = path_escaped
    )
}

/// Build a shell command that decodes a base64 payload into a remote file via here-doc.
pub(crate) fn cmd_decode_to_file(path_escaped: &str, b64_payload: &str) -> String {
    format!(
        "(\
base64 -d 2>/dev/null > {p} || base64 -D 2>/dev/null > {p} || openssl base64 -d -A 2>/dev/null > {p}\
) << 'MARCEL_B64_EOF'\n{payload}\nMARCEL_B64_EOF",
        p = path_escaped,
        payload = b64_payload,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b64_roundtrip_text() {
        let cases = [
            "",
            "a",
            "ab",
            "abc",
            "hello, world",
            "中文 🚀 混合内容\n第二行\r\n第三行",
        ];
        for s in cases {
            let enc = b64_encode(s.as_bytes());
            let dec = b64_decode(&enc).unwrap();
            assert_eq!(dec, s.as_bytes(), "roundtrip failed for {:?}", s);
        }
    }

    #[test]
    fn b64_roundtrip_binary() {
        let bytes: Vec<u8> = (0u8..=255).collect();
        let enc = b64_encode(&bytes);
        let dec = b64_decode(&enc).unwrap();
        assert_eq!(dec, bytes);
    }

    #[test]
    fn b64_decode_ignores_whitespace() {
        let enc = "aGVs\nbG8s\nIHdv\ncmxk";
        let dec = b64_decode(enc).unwrap();
        assert_eq!(dec, b"hello, world");
    }

    #[test]
    fn b64_decode_rejects_garbage() {
        assert!(b64_decode("***").is_err());
    }

    #[test]
    fn b64_roundtrip_binary_from_issue() {
        let data = b"\x00\x01\x02binary\xff\xfe test";
        let enc = b64_encode(data);
        assert_eq!(b64_decode(&enc).unwrap(), data);
    }
}
