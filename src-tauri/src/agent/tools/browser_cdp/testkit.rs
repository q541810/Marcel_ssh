//! Test-only in-process fake CDP peer.
//!
//! Why this exists: the real `browser_cdp` path spawns a local Chrome/Edge
//! process. That makes every CDP bug either untestable or (worse) testable only
//! by repeatedly launching browsers on a developer machine. This kit speaks
//! enough RFC6455 + CDP over a loopback `TcpListener` to drive
//! [`super::CdpPage`] deterministically, with **zero browser processes**.
//!
//! It reproduces the failure shapes the real peer produces:
//! - a reply that never arrives (the client must hit its own deadline),
//! - one frame delivered in two TCP writes (partial reads),
//! - an id-less event and an unparsable frame before the real response,
//! - a peer that closes mid-flight,
//! - a "stale document" that still reports `about:blank` after `Page.navigate`.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::Value;

const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// How the fake peer should react to a single CDP request.
#[derive(Clone, Debug)]
pub enum Reply {
    /// Reply with a `result` payload.
    Ok(Value),
    /// Reply with a CDP `error` payload.
    Err(String),
    /// Never reply (the client must hit its own deadline).
    Never,
    /// Send an unparsable frame, then an id-less event, then the response.
    NoiseThen(Value, Value),
    /// Send a websocket close frame instead of a reply.
    Close,
    /// Send one frame as two TCP writes separated by a delay.
    SplitAcrossWrites(Duration, Value),
}

/// Decides the reply for one request: `(method, params, request_index)`.
pub type Responder = Arc<dyn Fn(&str, &Value, usize) -> Reply + Send + Sync>;

/// A fully scripted CDP peer bound to loopback.
pub struct FakeCdp {
    pub addr: SocketAddr,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl FakeCdp {
    /// Start the peer; it accepts a single connection (one `CdpPage`).
    pub fn start(responder: Responder) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("local addr");
        let requests: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));

        let reqs = Arc::clone(&requests);
        let stop_flag = Arc::clone(&stop);
        let handle = thread::spawn(move || {
            let Ok((stream, _)) = listener.accept() else {
                return;
            };
            serve(stream, responder, reqs, stop_flag);
        });

        Self {
            addr,
            requests,
            stop,
            handle: Some(handle),
        }
    }

    /// WS URL to hand to `CdpPage::connect` (the page id is irrelevant).
    pub fn ws_url(&self) -> String {
        format!("ws://{}/devtools/page/fake", self.addr)
    }

    /// How many times a given method was received.
    pub fn count_of(&self, method: &str) -> usize {
        self.requests
            .lock()
            .expect("requests lock")
            .iter()
            .filter(|(m, _)| m == method)
            .count()
    }
}

impl Drop for FakeCdp {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Unblock a peer parked in `accept()`.
        let _ = TcpStream::connect(self.addr);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn serve(
    mut stream: TcpStream,
    responder: Responder,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    stop: Arc<AtomicBool>,
) {
    let _ = stream.set_read_timeout(Some(POLL_INTERVAL));
    let _ = stream.set_nodelay(true);

    // Bytes arriving after the handshake headers (a pipelined first frame) must
    // be carried into the frame reader, not dropped.
    let Some(leftover) = read_handshake(&mut stream, &stop) else {
        return;
    };
    if stream
        .write_all(
            b"HTTP/1.1 101 Switching Protocols\r\n\
              Upgrade: websocket\r\n\
              Connection: Upgrade\r\n\
              Sec-WebSocket-Accept: ZmFrZS1hY2NlcHQ=\r\n\r\n",
        )
        .is_err()
    {
        return;
    }
    let _ = stream.flush();

    let mut reader = FrameReader {
        stream,
        buf: leftover,
    };
    let mut index = 0usize;
    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let Some((opcode, payload)) = reader.next_frame(&stop) else {
            return;
        };
        match opcode {
            0x8 => return,
            0x9 => {
                if reader.write_frame(0xA, &payload).is_err() {
                    return;
                }
                continue;
            }
            0xA => continue,
            0x1 => {}
            _ => continue,
        }

        let Ok(text) = String::from_utf8(payload) else {
            continue;
        };
        let Ok(msg) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(id) = msg.get("id").and_then(|v| v.as_u64()) else {
            continue;
        };
        let method = msg
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let params = msg.get("params").cloned().unwrap_or(Value::Null);

        let this_index = index;
        index += 1;
        requests
            .lock()
            .expect("requests lock")
            .push((method.clone(), params.clone()));

        match responder(&method, &params, this_index) {
            Reply::Ok(result) => {
                if send_result(&mut reader, id, result).is_err() {
                    return;
                }
            }
            Reply::Err(message) => {
                let body =
                    serde_json::json!({"id": id, "error": {"code": -32000, "message": message}});
                if reader.write_text(&body.to_string()).is_err() {
                    return;
                }
            }
            Reply::Never => {}
            Reply::NoiseThen(event, result) => {
                if reader.write_text("{ not json at all").is_err() {
                    return;
                }
                if reader.write_text(&event.to_string()).is_err() {
                    return;
                }
                if send_result(&mut reader, id, result).is_err() {
                    return;
                }
            }
            Reply::Close => {
                let _ = reader.write_frame(0x8, &[]);
                return;
            }
            Reply::SplitAcrossWrites(delay, result) => {
                let body = serde_json::json!({"id": id, "result": result}).to_string();
                let frame = encode_frame(0x1, body.as_bytes());
                let mid = frame.len() / 2;
                if reader.stream.write_all(&frame[..mid]).is_err() {
                    return;
                }
                let _ = reader.stream.flush();
                thread::sleep(delay);
                if reader.stream.write_all(&frame[mid..]).is_err() {
                    return;
                }
                let _ = reader.stream.flush();
            }
        }
    }
}

fn send_result(reader: &mut FrameReader, id: u64, result: Value) -> std::io::Result<()> {
    let body = serde_json::json!({"id": id, "result": result});
    reader.write_text(&body.to_string())
}

/// Encode an unmasked server→client frame.
fn encode_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(payload.len() + 10);
    frame.push(0x80 | opcode);
    if payload.len() < 126 {
        frame.push(payload.len() as u8);
    } else if payload.len() <= 65_535 {
        frame.push(126);
        frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        frame.push(127);
        frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    frame.extend_from_slice(payload);
    frame
}

/// Read until the handshake terminator; returns any trailing bytes.
fn read_handshake(stream: &mut TcpStream, stop: &AtomicBool) -> Option<Vec<u8>> {
    let mut head = Vec::with_capacity(1024);
    let mut tmp = [0u8; 512];
    loop {
        if stop.load(Ordering::SeqCst) {
            return None;
        }
        match stream.read(&mut tmp) {
            Ok(0) => return None,
            Ok(n) => {
                head.extend_from_slice(&tmp[..n]);
                if let Some(pos) = head.windows(4).position(|w| w == b"\r\n\r\n") {
                    return Some(head[pos + 4..].to_vec());
                }
                if head.len() > 16_384 {
                    return None;
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return None,
        }
    }
}

struct FrameReader {
    stream: TcpStream,
    buf: Vec<u8>,
}

impl FrameReader {
    fn write_frame(&mut self, opcode: u8, payload: &[u8]) -> std::io::Result<()> {
        let frame = encode_frame(opcode, payload);
        self.stream.write_all(&frame)?;
        self.stream.flush()
    }

    fn write_text(&mut self, text: &str) -> std::io::Result<()> {
        self.write_frame(0x1, text.as_bytes())
    }

    fn next_frame(&mut self, stop: &AtomicBool) -> Option<(u8, Vec<u8>)> {
        loop {
            if stop.load(Ordering::SeqCst) {
                return None;
            }
            if let Some(frame) = self.try_parse() {
                return Some(frame);
            }
            let mut tmp = [0u8; 8192];
            match self.stream.read(&mut tmp) {
                Ok(0) => return None,
                Ok(n) => self.buf.extend_from_slice(&tmp[..n]),
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => return None,
            }
        }
    }

    /// Parse a complete frame out of the buffer, if one is available.
    fn try_parse(&mut self) -> Option<(u8, Vec<u8>)> {
        if self.buf.len() < 2 {
            return None;
        }
        let opcode = self.buf[0] & 0x0F;
        let masked = (self.buf[1] & 0x80) != 0;
        let mut len = (self.buf[1] & 0x7F) as usize;
        let mut offset = 2usize;

        if len == 126 {
            if self.buf.len() < offset + 2 {
                return None;
            }
            len = u16::from_be_bytes([self.buf[offset], self.buf[offset + 1]]) as usize;
            offset += 2;
        } else if len == 127 {
            if self.buf.len() < offset + 8 {
                return None;
            }
            let mut bytes = [0u8; 8];
            bytes.copy_from_slice(&self.buf[offset..offset + 8]);
            len = u64::from_be_bytes(bytes) as usize;
            offset += 8;
        }

        let mask_len = if masked { 4 } else { 0 };
        let total = offset + mask_len + len;
        if self.buf.len() < total {
            return None;
        }

        let mut payload = self.buf[offset + mask_len..total].to_vec();
        if masked {
            let mask = &self.buf[offset..offset + 4];
            for (i, byte) in payload.iter_mut().enumerate() {
                *byte ^= mask[i % 4];
            }
        }
        self.buf.drain(..total);
        Some((opcode, payload))
    }
}
