//! 同步服务端 WebSocket 客户端。
//!
//! 协议（与 server/ws.py 对齐）：
//! - 连接 `ws(s)://{host}/ws`，Header：`Authorization: Bearer <api_key>`
//! - 服务端 push 成功后广播 `{ "type": "changes_available", "data": { "source_device_id" } }`
//! - 本端只收信号，数据仍走 HTTPS pull
//! - 服务端 idle 超时：客户端须周期性发文本（保活），默认约 20s 发一次 `ping`
//!
//! 不传业务密文；断线重连由调用方（scheduler）循环。

use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

/// 客户端文本保活间隔（须小于服务端 idle = ping_interval + ping_timeout）
const CLIENT_PING_INTERVAL: Duration = Duration::from_secs(20);

/// 服务端 → 客户端消息（只解析 type）
#[derive(Debug, Deserialize)]
struct WsServerMessage {
    #[serde(rename = "type")]
    msg_type: String,
    #[allow(dead_code)]
    #[serde(default)]
    data: serde_json::Value,
}

/// 将 HTTP(S) base_url 转为 WebSocket URL（`/ws`）。
pub fn http_base_to_ws_url(base_url: &str) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("server url 为空".into());
    }
    if base.contains("localhost:0") || base.contains("127.0.0.1:0") {
        return Err("占位 server url，跳过 WS".into());
    }
    let ws = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{}/ws", rest)
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{}/ws", rest)
    } else if base.starts_with("wss://") || base.starts_with("ws://") {
        let b = base.trim_end_matches('/');
        if b.ends_with("/ws") {
            b.to_string()
        } else {
            format!("{}/ws", b)
        }
    } else {
        return Err(format!("无法从 server url 派生 WS 地址：{}", base));
    };
    Ok(ws)
}

/// 连接 WS 并阻塞读循环，直到断开或 `should_stop` 为 true。
///
/// `on_changes_available`：收到变更通知时调用（应快速返回或内部 spawn）。
pub async fn run_session<F, S>(
    base_url: &str,
    api_key: &str,
    mut should_stop: S,
    on_changes_available: F,
) -> Result<(), String>
where
    F: Fn(),
    S: FnMut() -> bool,
{
    let ws_url = http_base_to_ws_url(base_url)?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("构造 WS 请求失败：{}", e))?;

    let auth = format!("Bearer {}", api_key);
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&auth).map_err(|e| format!("Authorization 非法：{}", e))?,
    );

    log::info!("[sync-ws] 连接 {}", ws_url);
    let (ws_stream, _resp) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("WS 连接失败：{}", e))?;

    let (mut write, mut read) = ws_stream.split();
    let mut ping_tick = tokio::time::interval(CLIENT_PING_INTERVAL);
    // 跳过首次立即 tick，连上后再过 interval 发第一帧
    ping_tick.tick().await;

    log::info!("[sync-ws] 已连接");

    loop {
        if should_stop() {
            let _ = write.close().await;
            return Ok(());
        }

        tokio::select! {
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_text(&text, &on_changes_available);
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if write.send(Message::Pong(payload)).await.is_err() {
                            return Err("WS 发送 pong 失败".into());
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        log::info!("[sync-ws] 对端关闭连接");
                        return Ok(());
                    }
                    Some(Ok(Message::Pong(_))) | Some(Ok(Message::Binary(_)))
                    | Some(Ok(Message::Frame(_))) => {}
                    Some(Err(e)) => {
                        return Err(format!("WS 读错误：{}", e));
                    }
                }
            }
            _ = ping_tick.tick() => {
                // 服务端用 receive_text idle 超时；发文本保活（非协议层 Ping）
                if write.send(Message::Text("ping".into())).await.is_err() {
                    return Err("WS 发送保活失败".into());
                }
            }
        }
    }
}

fn handle_text<F: Fn()>(text: &str, on_changes_available: &F) {
    let Ok(msg) = serde_json::from_str::<WsServerMessage>(text) else {
        // 非 JSON（如服务端未定义的文本）忽略
        return;
    };
    match msg.msg_type.as_str() {
        "changes_available" => {
            log::info!("[sync-ws] 收到 changes_available");
            on_changes_available();
        }
        "device_online" | "device_offline" => {
            log::debug!("[sync-ws] {}", msg.msg_type);
        }
        other => {
            log::debug!("[sync-ws] 忽略消息 type={}", other);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_http_to_ws_url() {
        assert_eq!(
            http_base_to_ws_url("https://ssh.neopig.top").unwrap(),
            "wss://ssh.neopig.top/ws"
        );
        assert_eq!(
            http_base_to_ws_url("http://192.168.1.1:8787/").unwrap(),
            "ws://192.168.1.1:8787/ws"
        );
        assert!(http_base_to_ws_url("http://localhost:0").is_err());
    }
}
