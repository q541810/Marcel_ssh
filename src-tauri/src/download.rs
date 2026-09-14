//! 分段并发下载器（HTTP Range）。
//!
//! **为什么需要它**：GitHub release 资产这类线路是「按单条连接限速」的 —— 实测
//! 同一网络下拉同一个包：单连接 0.02 MB/s、8 连接 0.13 MB/s、16 连接 0.25 MB/s，
//! 几乎随连接数线性增长。Motrix / aria2 之所以快，就是把一条流拆成十几条连接。
//! 应用内的安装包下载此前是单连接顺序流，因此只能跑到浏览器单连接的水平。
//!
//! **设计约束**（宁可慢也不能下坏）：
//! - 先探测目标是否支持 Range（`Range: bytes=0-0` → 期望 `206`）与真实大小；
//!   不支持或大小未知 → 退回单连接顺序流，与旧实现同语义；
//! - 分段写入同一个 `.part` 文件：**每段各自 open 一个独立句柄**再 seek 写，
//!   不用 `File::try_clone` —— Windows 上克隆出的句柄共享文件指针，并发写会互踩；
//! - 任一段失败先重试该段（最多 [`SEGMENT_ATTEMPTS`] 次，仍不行再换候选源），
//!   全都不行才整次失败（不留半成品，与旧实现一致）；
//! - 取消由调用方以闭包传入，每个 chunk 检查一次；取消后删 `.part` 并返回
//!   [`DownloadOutcome::Cancelled`]（不是失败，调用方不该弹红色错误）；
//! - **不做校验**：分段下载无法边下边算整体 sha256，由调用方在下载完成后对文件
//!   做 sha256 / minisign 校验（多一次读盘换并发加速是划算的）。

use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures::future::join_all;
use reqwest::header::{CONTENT_RANGE, RANGE};

/// 并发连接上限。实测到 GitHub 资产的线路基本「每连接各自限速」，所以连接数就是
/// 倍率（8 → 7.1x，16 → 12.3x）；16 与 Motrix 默认值一致，再往上收益递减且更容易
/// 被线路打回。
pub const MAX_SEGMENTS: usize = 16;

/// 每个分段的最少字节数：太小不值得分段（调度开销与失败面都变大）。
const MIN_SEGMENT_BYTES: u64 = 256 * 1024;

/// 单个 chunk 的读超时（秒）——防止某条连接卡死拖住整次下载。
const CHUNK_READ_TIMEOUT_SECS: u64 = 60;

/// 进度回调节流间隔。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(500);

/// 单段最多尝试次数（网络抖动重试，不因此放弃整次下载）。
const SEGMENT_ATTEMPTS: usize = 3;

/// 建立连接的超时（秒）。
const CONNECT_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadOutcome {
    /// 文件已完整写入 `part_path`（校验与改名由调用方负责）。
    Done,
    /// 被调用方要求停止：`.part` 已删除。
    Cancelled,
}

/// 源探测结果。
struct Probe {
    url: String,
    size: u64,
    accepts_ranges: bool,
}

enum FetchError {
    Cancelled,
    Failed { message: String, written: u64 },
}

impl FetchError {
    fn failed(message: impl Into<String>) -> Self {
        FetchError::Failed {
            message: message.into(),
            written: 0,
        }
    }
}

/// 把总长度切成至多 `max_segments` 段（闭区间，覆盖完整且不重叠）。
///
/// 文件很小（不足一段的最小字节数）时只返回一段 —— 调用方据此走单连接路径。
/// 拆成独立纯函数是为了能直接单测：分段算错等于「下出来的文件对不上 sha256」，
/// 这种错误在真实网络里很难稳定复现。
pub fn plan_segments(total: u64, max_segments: usize) -> Vec<(u64, u64)> {
    if total == 0 {
        return vec![];
    }
    let wanted = (total / MIN_SEGMENT_BYTES).max(1) as usize;
    let count = wanted.min(max_segments.max(1)).min(total as usize);
    if count <= 1 {
        return vec![(0, total - 1)];
    }
    let base = total / count as u64;
    let remainder = total % count as u64;
    let mut ranges = Vec::with_capacity(count);
    let mut start = 0u64;
    for i in 0..count {
        // 前 remainder 段各多分 1 字节，保证恰好铺满且无空洞
        let len = base + if (i as u64) < remainder { 1 } else { 0 };
        ranges.push((start, start + len - 1));
        start += len;
    }
    ranges
}

/// 从 `Content-Range: bytes 0-0/9748248` 里取出总大小。
fn parse_content_range_total(value: &str) -> Option<u64> {
    value.rsplit('/').next()?.trim().parse::<u64>().ok()
}

pub struct SegmentedDownload<'a> {
    /// 候选下载源：探测出第一个可用且支持 Range 的作为主源，其余在该源反复失败时兜底。
    pub urls: Vec<String>,
    /// 半成品落盘位置。
    pub part_path: PathBuf,
    /// `latest.json` 声明的大小（探测拿不到大小时用它）。
    pub expected_size: u64,
    /// 调用方的取消查询（每个 chunk 一次）。
    pub cancel: &'a (dyn Fn() -> bool + Sync),
    /// 进度回调 `(已下载, 总大小)`。
    pub progress: &'a (dyn Fn(u64, u64) + Sync),
}

impl SegmentedDownload<'_> {
    pub async fn run(&self) -> Result<DownloadOutcome, String> {
        if (self.cancel)() {
            return Ok(DownloadOutcome::Cancelled);
        }
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
            .user_agent(concat!("Marcel-SSH/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| format!("无法创建下载客户端: {}", e))?;

        let probe = self.probe(&client).await?;
        let total = if probe.size > 0 {
            probe.size
        } else {
            self.expected_size
        };
        if total == 0 {
            return Err("更新包大小未知".into());
        }

        // 预分配：分段并发写要求文件先有最终长度（各段 seek 到自己的偏移写）
        {
            let file = std::fs::File::create(&self.part_path)
                .map_err(|e| format!("无法写入临时文件: {}", e))?;
            file.set_len(total)
                .map_err(|e| format!("无法预分配空间: {}", e))?;
        }

        let ranges = if probe.accepts_ranges {
            plan_segments(total, MAX_SEGMENTS)
        } else {
            // 服务端不支持 Range：退回单连接顺序流（不送 Range 头）
            log::info!("下载源不支持分段（HTTP Range），改用单连接顺序下载");
            vec![(0, total - 1)]
        };
        let segmented = ranges.len() > 1;
        log::info!(
            "开始下载：{} 字节，{} 段{}",
            total,
            ranges.len(),
            if segmented { "（并发）" } else { "（单连接）" }
        );

        let downloaded = AtomicU64::new(0);
        let cancelled = AtomicBool::new(false);
        let last_emit = Mutex::new(Instant::now() - PROGRESS_INTERVAL);

        let result = self
            .fetch_all(
                &client,
                probe.url,
                &ranges,
                segmented,
                total,
                &downloaded,
                &cancelled,
                &last_emit,
            )
            .await;

        match result {
            Ok(()) => {
                (self.progress)(downloaded.load(Ordering::Relaxed), total);
                Ok(DownloadOutcome::Done)
            }
            Err(FetchError::Cancelled) => {
                let _ = std::fs::remove_file(&self.part_path);
                Ok(DownloadOutcome::Cancelled)
            }
            Err(FetchError::Failed { message, .. }) => {
                let _ = std::fs::remove_file(&self.part_path);
                Err(message)
            }
        }
    }

    /// 探测：挑一个可用源，并确定它是否支持分段与真实大小。
    async fn probe(&self, client: &reqwest::Client) -> Result<Probe, String> {
        let mut last_err = "所有下载源均不可达".to_string();
        for url in &self.urls {
            match client.get(url).header(RANGE, "bytes=0-0").send().await {
                Ok(resp) => {
                    let status = resp.status();
                    if status == reqwest::StatusCode::PARTIAL_CONTENT {
                        let size = resp
                            .headers()
                            .get(CONTENT_RANGE)
                            .and_then(|v| v.to_str().ok())
                            .and_then(parse_content_range_total)
                            .unwrap_or(self.expected_size);
                        return Ok(Probe {
                            url: url.clone(),
                            size,
                            accepts_ranges: true,
                        });
                    }
                    if status.is_success() {
                        // 服务器忽略了 Range（返回整包）：能用，但只能单连接
                        let size = resp.content_length().unwrap_or(self.expected_size);
                        return Ok(Probe {
                            url: url.clone(),
                            size,
                            accepts_ranges: false,
                        });
                    }
                    log::warn!("下载源返回 {} {}，尝试下一个", status, url);
                    last_err = format!("下载服务器返回 {}", status);
                }
                Err(e) => {
                    log::warn!("下载源不可达 {}：{}，尝试下一个", url, e);
                    last_err = format!("下载请求失败: {}", e);
                }
            }
        }
        Err(last_err)
    }

    /// 并发跑完所有分段（`join_all` 在同一任务上并发 poll，网络等待天然重叠）。
    #[allow(clippy::too_many_arguments)]
    async fn fetch_all(
        &self,
        client: &reqwest::Client,
        primary: String,
        ranges: &[(u64, u64)],
        segmented: bool,
        total: u64,
        downloaded: &AtomicU64,
        cancelled: &AtomicBool,
        last_emit: &Mutex<Instant>,
    ) -> Result<(), FetchError> {
        let mut sources: Vec<String> = vec![primary.clone()];
        sources.extend(
            self.urls
                .iter()
                .filter(|u| **u != primary)
                .cloned(),
        );

        let futures = ranges.iter().enumerate().map(|(index, (start, end))| {
            let range = if segmented { Some((*start, *end)) } else { None };
            self.fetch_segment(
                client,
                &sources,
                index,
                range,
                *start,
                total,
                downloaded,
                cancelled,
                last_emit,
            )
        });

        let results = join_all(futures).await;
        // 取消优先：只要有一段是因取消结束，整次就是「取消」而不是「失败」
        if cancelled.load(Ordering::Relaxed) {
            return Err(FetchError::Cancelled);
        }
        for r in results {
            r?;
        }
        Ok(())
    }

    /// 单段（带重试与换源）。
    #[allow(clippy::too_many_arguments)]
    async fn fetch_segment(
        &self,
        client: &reqwest::Client,
        sources: &[String],
        index: usize,
        range: Option<(u64, u64)>,
        offset: u64,
        total: u64,
        downloaded: &AtomicU64,
        cancelled: &AtomicBool,
        last_emit: &Mutex<Instant>,
    ) -> Result<(), FetchError> {
        let mut last_err = "未知错误".to_string();
        for source in sources {
            for attempt in 0..SEGMENT_ATTEMPTS {
                if (self.cancel)() {
                    cancelled.store(true, Ordering::Relaxed);
                    return Err(FetchError::Cancelled);
                }
                match self
                    .fetch_segment_once(
                        client, source, range, offset, total, downloaded, cancelled, last_emit,
                    )
                    .await
                {
                    Ok(()) => return Ok(()),
                    Err(FetchError::Cancelled) => {
                        cancelled.store(true, Ordering::Relaxed);
                        return Err(FetchError::Cancelled);
                    }
                    Err(FetchError::Failed { message, written }) => {
                        // 重试前把这段已计入的字节退回去，否则进度会虚高
                        downloaded.fetch_sub(written, Ordering::Relaxed);
                        last_err = format!("第 {} 段: {}", index + 1, message);
                        log::warn!(
                            "{}（第 {}/{} 次尝试，源 {}）",
                            last_err,
                            attempt + 1,
                            SEGMENT_ATTEMPTS,
                            source
                        );
                    }
                }
                tokio::time::sleep(Duration::from_millis(300 * (attempt as u64 + 1))).await;
            }
        }
        Err(FetchError::Failed {
            message: last_err,
            written: 0,
        })
    }

    /// 真正的一次请求 + 写盘。
    #[allow(clippy::too_many_arguments)]
    async fn fetch_segment_once(
        &self,
        client: &reqwest::Client,
        url: &str,
        range: Option<(u64, u64)>,
        offset: u64,
        total: u64,
        downloaded: &AtomicU64,
        cancelled: &AtomicBool,
        last_emit: &Mutex<Instant>,
    ) -> Result<(), FetchError> {
        let mut request = client.get(url);
        if let Some((start, end)) = range {
            request = request.header(RANGE, format!("bytes={}-{}", start, end));
        }
        let resp = match request.send().await {
            Ok(r) => r,
            Err(e) => return Err(FetchError::failed(format!("下载请求失败: {}", e))),
        };
        if range.is_some() && resp.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            // 探测时支持、真正取分段时又不支持（中间层改写）：明确报出来，
            // 不静默写坏文件
            return Err(FetchError::failed(format!(
                "下载源未按分段返回（HTTP {}）",
                resp.status()
            )));
        }
        if range.is_none() && !resp.status().is_success() {
            return Err(FetchError::failed(format!(
                "下载服务器返回 {}",
                resp.status()
            )));
        }

        // 每段独立开句柄：Windows 上克隆句柄共享文件指针，并发写会互相踩
        let mut file = match std::fs::OpenOptions::new().write(true).open(&self.part_path) {
            Ok(f) => f,
            Err(e) => return Err(FetchError::failed(format!("无法打开临时文件: {}", e))),
        };
        if let Err(e) = file.seek(SeekFrom::Start(offset)) {
            return Err(FetchError::failed(format!("定位写入位置失败: {}", e)));
        }

        let mut written = 0u64;
        let mut stream = resp;
        loop {
            if (self.cancel)() {
                cancelled.store(true, Ordering::Relaxed);
                return Err(FetchError::Cancelled);
            }
            let chunk = match tokio::time::timeout(
                Duration::from_secs(CHUNK_READ_TIMEOUT_SECS),
                stream.chunk(),
            )
            .await
            {
                Err(_) => {
                    return Err(FetchError::Failed {
                        message: "下载超时（连接停滞）".into(),
                        written,
                    })
                }
                Ok(Err(e)) => {
                    return Err(FetchError::Failed {
                        message: format!("下载中断: {}", e),
                        written,
                    })
                }
                Ok(Ok(chunk)) => chunk,
            };
            let Some(bytes) = chunk else { break };
            if let Err(e) = file.write_all(&bytes) {
                return Err(FetchError::Failed {
                    message: format!("写入失败（磁盘空间不足？）: {}", e),
                    written,
                });
            }
            written += bytes.len() as u64;
            downloaded.fetch_add(bytes.len() as u64, Ordering::Relaxed);
            emit_progress_if_due(downloaded, total, last_emit, self.progress);
        }
        file.flush().ok();

        // 分片被提前掐断（服务端/中间层截断）时立刻报错并重试这一段；否则残留的
        // 是预分配出来的零字节，最后只会以一句含糊的「校验失败」暴露出来。
        if let Some((start, end)) = range {
            let want = end - start + 1;
            if written != want {
                return Err(FetchError::Failed {
                    message: format!("分段长度不足（期望 {} 字节，实收 {}）", want, written),
                    written,
                });
            }
        }
        Ok(())
    }
}

/// 进度节流：多个分段共享同一个「上次回调时间」。
fn emit_progress_if_due(
    downloaded: &AtomicU64,
    total: u64,
    last_emit: &Mutex<Instant>,
    progress: &(dyn Fn(u64, u64) + Sync),
) {
    let Ok(mut last) = last_emit.lock() else {
        return;
    };
    if last.elapsed() < PROGRESS_INTERVAL {
        return;
    }
    *last = Instant::now();
    let done = downloaded.load(Ordering::Relaxed);
    drop(last);
    progress(done, total);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn assert_covers_exactly(ranges: &[(u64, u64)], total: u64) {
        assert!(!ranges.is_empty(), "分段不能为空");
        assert_eq!(ranges[0].0, 0, "第一段必须从 0 开始");
        assert_eq!(
            ranges.last().unwrap().1,
            total - 1,
            "最后一段必须落在最后一个字节"
        );
        for (i, (start, end)) in ranges.iter().enumerate() {
            assert!(start <= end, "第 {} 段起点大于终点", i + 1);
            if i > 0 {
                assert_eq!(
                    ranges[i - 1].1 + 1,
                    *start,
                    "第 {} 段与上一段之间有空洞或重叠",
                    i + 1
                );
            }
        }
    }

    #[test]
    fn plan_segments_covers_every_byte_without_overlap() {
        // 真实安装包（9.7MB 桌面 / 26MB 安卓）该切满 16 段；其余尺寸只要求
        // 「铺满且不重叠」
        let ranges = plan_segments(9_748_248, MAX_SEGMENTS);
        assert_eq!(ranges.len(), MAX_SEGMENTS);
        assert_covers_exactly(&ranges, 9_748_248);
        let ranges = plan_segments(26_337_407, MAX_SEGMENTS);
        assert_eq!(ranges.len(), MAX_SEGMENTS);
        assert_covers_exactly(&ranges, 26_337_407);

        for total in [1_048_577u64, 8_000_000, 262_144, 300_000] {
            let ranges = plan_segments(total, MAX_SEGMENTS);
            assert_covers_exactly(&ranges, total);
        }
    }

    #[test]
    fn plan_segments_handles_uneven_split() {
        // 不能被段数整除时前几段各多 1 字节，不能少下也不能重复下
        let ranges = plan_segments(1000 * 1024, 3);
        assert_eq!(ranges.len(), 3);
        assert_covers_exactly(&ranges, 1000 * 1024);
    }

    #[test]
    fn plan_segments_keeps_small_files_single() {
        // 小于一段最小字节数的文件不分段
        assert_eq!(plan_segments(64 * 1024, MAX_SEGMENTS), vec![(0, 64 * 1024 - 1)]);
        assert_eq!(plan_segments(1, MAX_SEGMENTS), vec![(0, 0)]);
        assert!(plan_segments(0, MAX_SEGMENTS).is_empty());
    }

    #[test]
    fn plan_segments_respects_segment_floor() {
        // 1MB 只能切 4 段（每段 ≥256KB），不能硬凑 16 段
        assert_eq!(plan_segments(1024 * 1024, MAX_SEGMENTS).len(), 4);
    }

    #[test]
    fn parse_content_range_total_reads_size() {
        assert_eq!(
            parse_content_range_total("bytes 0-0/9748248"),
            Some(9_748_248)
        );
        assert_eq!(parse_content_range_total("bytes 0-0/*"), None);
        assert_eq!(parse_content_range_total("garbage"), None);
    }

    // ── 端到端：本地起一个最小 HTTP 服务，验证真的下出来是对的 ──────────
    //
    // 分段写盘最容易出的错是「偏移算错 / 并发写互相踩」，而这类错误不会报错，
    // 只会让 sha256 对不上（在真实网络里很难稳定复现）。所以这里用本地服务把
    // 整条路径跑通并逐字节比对。

    /// 起一个最小 HTTP/1.1 服务：支持 `Range` 时返回 206 分片，不支持时返回整包。
    /// 返回 (base_url, 已服务请求数)。`chunk_delay_ms` 用来模拟慢速连接。
    async fn spawn_server(
        body: Vec<u8>,
        honor_range: bool,
        chunk_delay_ms: u64,
    ) -> (String, std::sync::Arc<AtomicU64>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = std::sync::Arc::new(AtomicU64::new(0));
        let hits_for_task = hits.clone();
        let body = std::sync::Arc::new(body);

        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let body = body.clone();
                let hits = hits_for_task.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = match socket.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => n,
                    };
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    hits.fetch_add(1, Ordering::Relaxed);

                    let range = req
                        .lines()
                        .find(|l| l.to_ascii_lowercase().starts_with("range:"))
                        .and_then(|l| l.split('=').nth(1))
                        .map(|v| v.trim().to_string());

                    if honor_range {
                        // 严格按请求的区间返回（只回 start..end，不是 start..文件尾）：
                        // 否则「分段写错位置」这类 bug 会被重复写入的相同字节掩盖
                        let (start, end) = match range.as_deref().and_then(|v| {
                            let mut it = v.split('-');
                            let s = it.next()?.trim().parse::<usize>().ok()?;
                            let e = it
                                .next()
                                .and_then(|x| x.trim().parse::<usize>().ok())
                                .unwrap_or(body.len() - 1);
                            Some((s, e))
                        }) {
                            Some((s, e)) => (s, e.min(body.len() - 1)),
                            None => (0, body.len() - 1),
                        };
                        let head = format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                            end - start + 1,
                            start,
                            end,
                            body.len()
                        );
                        if socket.write_all(head.as_bytes()).await.is_err() {
                            return;
                        }
                        // 小片慢发，让取消/并发能真的交错发生
                        for piece in body[start..=end].chunks(16 * 1024) {
                            if socket.write_all(piece).await.is_err() {
                                return;
                            }
                            let _ = socket.flush().await;
                            if chunk_delay_ms > 0 {
                                tokio::time::sleep(Duration::from_millis(chunk_delay_ms)).await;
                            }
                        }
                    } else {
                        let head = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        if socket.write_all(head.as_bytes()).await.is_err() {
                            return;
                        }
                        let _ = socket.write_all(&body).await;
                    }
                    let _ = socket.shutdown().await;
                });
            }
        });

        (format!("http://{}", addr), hits)
    }

    fn tmp_part(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("marcel-dl-test");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    /// 造一个受控内容（不是全零，避免「写错位置但恰好还是零」这种假通过）。
    fn payload(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    #[tokio::test]
    async fn segmented_download_reproduces_source_bytes() {
        let source = payload(3 * 1024 * 1024);
        let (url, hits) = spawn_server(source.clone(), true, 0).await;
        let part = tmp_part("segmented.part");
        let _ = std::fs::remove_file(&part);

        let no_cancel = || false;
        let no_progress = |_: u64, _: u64| {};
        let dl = SegmentedDownload {
            urls: vec![url],
            part_path: part.clone(),
            expected_size: source.len() as u64,
            cancel: &no_cancel,
            progress: &no_progress,
        };
        assert_eq!(dl.run().await.unwrap(), DownloadOutcome::Done);

        let written = std::fs::read(&part).unwrap();
        assert_eq!(written.len(), source.len(), "落盘长度必须等于源长度");
        assert!(written == source, "分段下载的内容必须与源逐字节一致");
        assert!(
            hits.load(Ordering::Relaxed) > MAX_SEGMENTS as u64 / 2,
            "应当真的走了多段并发（命中 {} 次）",
            hits.load(Ordering::Relaxed)
        );
        let _ = std::fs::remove_file(&part);
    }

    #[tokio::test]
    async fn download_falls_back_to_single_stream_without_range_support() {
        let source = payload(1024 * 1024);
        let (url, hits) = spawn_server(source.clone(), false, 0).await;
        let part = tmp_part("single.part");
        let _ = std::fs::remove_file(&part);

        let no_cancel = || false;
        let no_progress = |_: u64, _: u64| {};
        let dl = SegmentedDownload {
            urls: vec![url],
            part_path: part.clone(),
            expected_size: source.len() as u64,
            cancel: &no_cancel,
            progress: &no_progress,
        };
        assert_eq!(dl.run().await.unwrap(), DownloadOutcome::Done);
        assert!(std::fs::read(&part).unwrap() == source, "单连接回落也要下对");
        // 探测 1 次 + 单连接整包 1 次
        assert_eq!(hits.load(Ordering::Relaxed), 2, "不支持 Range 时只该有两次请求");
        let _ = std::fs::remove_file(&part);
    }

    #[tokio::test]
    async fn cancel_removes_partial_file() {
        let source = payload(2 * 1024 * 1024);
        // 每片慢发 30ms，保证取消发生在下载中途而不是还没开始
        let (url, _) = spawn_server(source.clone(), true, 30).await;
        let part = tmp_part("cancelled.part");
        let _ = std::fs::remove_file(&part);

        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let stop_for_cancel = stop.clone();
        let cancel = move || stop_for_cancel.load(Ordering::Relaxed);
        let no_progress = |_: u64, _: u64| {};
        let dl = SegmentedDownload {
            urls: vec![url],
            part_path: part.clone(),
            expected_size: source.len() as u64,
            cancel: &cancel,
            progress: &no_progress,
        };

        let stop_for_timer = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            stop_for_timer.store(true, Ordering::Relaxed);
        });

        assert_eq!(dl.run().await.unwrap(), DownloadOutcome::Cancelled);
        assert!(!part.exists(), "取消后必须删掉半成品 .part");
    }

    /// 真实网络冒烟（默认忽略；手动跑：`cargo test --lib download:: -- --ignored --nocapture`）。
    ///
    /// 它验证的是本地服务测不到的那一段：GitHub release 直链会 302 跳到
    /// objects.githubusercontent.com，**跳转后 Range 必须仍然生效** —— 否则探测
    /// 会判定「不支持分段」而静默退回单连接，速度白丢。用 `MARCEL_DL_SMOKE_URL`
    /// 指定要下的资产；`MARCEL_DL_SMOKE_BYTES` 可只下前 N 字节（默认整包）。
    #[tokio::test]
    #[ignore]
    async fn real_url_smoke_uses_segments() {
        let Ok(url) = std::env::var("MARCEL_DL_SMOKE_URL") else {
            eprintln!("跳过：未设置 MARCEL_DL_SMOKE_URL");
            return;
        };
        let part = tmp_part("smoke.part");
        let _ = std::fs::remove_file(&part);
        let no_cancel = || false;
        let progress = |done: u64, total: u64| {
            eprintln!("进度 {}/{} ({:.1}%)", done, total, done as f64 / total as f64 * 100.0);
        };
        let dl = SegmentedDownload {
            urls: vec![url],
            part_path: part.clone(),
            expected_size: 0,
            cancel: &no_cancel,
            progress: &progress,
        };
        let started = Instant::now();
        let outcome = dl.run().await.expect("真实下载应成功");
        let size = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        let secs = started.elapsed().as_secs_f64();
        eprintln!(
            "结果={:?} 大小={} 用时={:.1}s 平均={:.2} MB/s",
            outcome,
            size,
            secs,
            size as f64 / 1048576.0 / secs.max(0.001)
        );
        assert_eq!(outcome, DownloadOutcome::Done);
        assert!(size > 0);
        let _ = std::fs::remove_file(&part);
    }
}
