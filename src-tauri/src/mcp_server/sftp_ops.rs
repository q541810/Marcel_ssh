// SFTP 操作的 MCP 对外接口
//
// 与 `external_executor` 分工：那边负责「connection_id → 无头会话」的解析，
// 这里只做纯 SFTP 动作，参数一律是已经解析好的 `session_id`。
// 这样会话解析只有一处（executor），SFTP 侧不重复建连逻辑。

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::error::AppError;
use crate::SshManager;

/// SFTP 传输结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferResult {
    pub success: bool,
    pub bytes_transferred: u64,
    pub duration_ms: u64,
}

/// SFTP 文件/目录信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub modified: Option<u64>,
    pub permissions: Option<String>,
}

/// SFTP 操作执行器
pub struct SftpExecutor {
    ssh_manager: Arc<SshManager>,
}

impl SftpExecutor {
    pub fn new(ssh_manager: Arc<SshManager>) -> Self {
        Self { ssh_manager }
    }

    /// 逐级创建远端目录（`mkdir -p` 语义）。已存在视为成功。
    ///
    /// 为什么要逐级：SFTP 的 `create_dir` 不递归，父目录不存在时直接失败。
    /// 为什么要查 `try_exists`：mkdir 没有「存在即成功」这种原子语义，
    /// 失败既可能是「已经在了」（正常）也可能是「没权限」（要报错）——
    /// 不区分就会把权限问题吞掉，让调用方在后续 create 时收到一句莫名其妙的错误。
    async fn ensure_remote_dir(sftp: &SftpSession, dir: &str) -> Result<(), AppError> {
        if dir.is_empty() || dir == "/" {
            return Ok(());
        }
        let mut acc = String::new();
        for part in dir.split('/').filter(|p| !p.is_empty()) {
            acc.push('/');
            acc.push_str(part);
            if sftp.create_dir(acc.as_str()).await.is_err() {
                match sftp.try_exists(acc.as_str()).await {
                    Ok(true) => {}
                    _ => return Err(AppError::Ssh(format!("创建远端目录失败: {}", acc))),
                }
            }
        }
        Ok(())
    }

    /// 上传本地文件到远端。
    ///
    /// 字节传送复用应用内的共享流式内核
    /// [`crate::commands::sftp::stream_upload_single_file`]——与 SFTP 面板、
    /// Agent 传输工具走同一条道：分块读写、sidecar 临时文件 + 原子提交、
    /// 完整性校验、可取消。`app` 传 `None`：无头调用方没有前端可通知，
    /// 内核会跳过进度/完成事件。
    ///
    /// 历史：本函数曾自带一套「整文件读进内存 + 单次 write_all」的实现，
    /// 大文件会在 SFTP 窗口写满后长时间阻塞，且整条链路没有超时与取消点，
    /// 会把 MCP 的串行请求分发一起拖死。
    pub async fn upload(
        &self,
        session_id: &str,
        local_path: &str,
        remote_path: &str,
    ) -> Result<TransferResult, AppError> {
        self.upload_with_cancel(session_id, local_path, remote_path, None, None)
            .await
    }

    pub async fn upload_with_cancel(
        &self,
        session_id: &str,
        local_path: &str,
        remote_path: &str,
        cancel: Option<watch::Receiver<bool>>,
        on_progress: Option<&(dyn Fn(u64, u64) + Send + Sync)>,
    ) -> Result<TransferResult, AppError> {
        if cancel.as_ref().is_some_and(|rx| *rx.borrow()) {
            return Err(AppError::Cancelled("请求已取消".into()));
        }
        log::info!(
            "[MCP SFTP] upload: session={}, local={}, remote={}",
            session_id,
            local_path,
            remote_path
        );

        let local_meta = tokio::fs::metadata(local_path)
            .await
            .map_err(|_| AppError::Config(format!("本地文件不存在: {}", local_path)))?;
        if local_meta.is_dir() {
            return Err(AppError::Config(format!(
                "本地路径是目录，请使用文件夹上传: {}",
                local_path
            )));
        }
        let total = local_meta.len();

        let mut local_file = tokio::fs::File::open(local_path)
            .await
            .map_err(|e| AppError::Config(format!("打开本地文件失败: {}: {}", local_path, e)))?;

        let sftp = self.ssh_manager.open_sftp(session_id).await?;

        // schema 承诺「自动创建远程目录（如果不存在）」，这里兑现它
        if let Some(parent) = Path::new(remote_path).parent() {
            if let Some(parent) = parent.to_str() {
                Self::ensure_remote_dir(&sftp, parent).await?;
            }
        }

        // 取消通道由调用方提供（同步请求用 MCP 请求取消，后台任务用任务表）；
        // 没人取消时保留一个永不置位的本地通道。
        let (_never_cancel_tx, never_cancel_rx) = watch::channel(false);
        let mut cancel_rx = cancel.unwrap_or(never_cancel_rx);

        let start = Instant::now();
        let upload_id = format!("mcp-upload-{}", uuid::Uuid::new_v4());
        crate::commands::sftp::stream_upload_single_file(
            None,
            &sftp,
            &mut local_file,
            total,
            true,
            remote_path,
            &upload_id,
            &mut cancel_rx,
            on_progress,
        )
        .await?;

        Ok(TransferResult {
            success: true,
            bytes_transferred: total,
            duration_ms: start.elapsed().as_millis() as u64,
        })
    }

    /// 从远端下载文件到本地。
    ///
    /// 字节传送复用应用内的共享流式内核
    /// [`crate::commands::sftp::stream_download_single_file`]——与 SFTP 面板、
    /// Agent 传输工具走同一条道：独占裸会话并发预取 READ、`.part` 临时文件 +
    /// 原子替换（含已有文件备份与失败回滚）、完整性校验、可取消。
    /// `app` 传 `None`：无头调用方没有前端可通知，内核会跳过事件。
    ///
    /// 历史：本函数曾用 `read_to_end` 把整个远端文件读进内存再 `fs::write`，
    /// 大文件既吃内存又只有一个 RTT 一个块的串行读，且没有取消点。
    pub async fn download(
        &self,
        session_id: &str,
        remote_path: &str,
        local_path: &str,
    ) -> Result<TransferResult, AppError> {
        self.download_with_cancel(session_id, remote_path, local_path, None, None)
            .await
    }

    pub async fn download_with_cancel(
        &self,
        session_id: &str,
        remote_path: &str,
        local_path: &str,
        cancel: Option<watch::Receiver<bool>>,
        on_progress: Option<&(dyn Fn(u64, u64) + Send + Sync)>,
    ) -> Result<TransferResult, AppError> {
        if cancel.as_ref().is_some_and(|rx| *rx.borrow()) {
            return Err(AppError::Cancelled("请求已取消".into()));
        }
        log::info!(
            "[MCP SFTP] download: session={}, remote={}, local={}",
            session_id,
            remote_path,
            local_path
        );

        let start = Instant::now();

        // 高层会话只做 stat（判断是不是普通文件、拿总长度）
        let sftp = self.ssh_manager.open_sftp(session_id).await?;
        let metadata = sftp
            .metadata(remote_path)
            .await
            .map_err(|e| AppError::Ssh(format!("获取远端文件信息失败: {}: {}", remote_path, e)))?;
        if metadata.is_dir() {
            return Err(AppError::Ssh(format!(
                "远端路径是目录，请使用文件夹下载: {}",
                remote_path
            )));
        }
        let total = metadata.len();

        // 数据面走独占裸会话（并发预取 READ），与面板/Agent 下载同一条道
        let (raw, read_chunk) = self.ssh_manager.open_sftp_raw(session_id).await?;
        let raw = Arc::new(raw);
        let remote_handle = raw
            .open(
                remote_path,
                OpenFlags::READ,
                russh_sftp::protocol::FileAttributes::default(),
            )
            .await
            .map_err(|e| AppError::Ssh(format!("打开远端文件失败: {}: {}", remote_path, e)))?
            .handle;

        // 本地父目录不存在就建出来（外部调用方给的路径未必已存在）
        if let Some(parent) = Path::new(local_path).parent() {
            if !parent.as_os_str().is_empty() {
                tokio::fs::create_dir_all(parent).await?;
            }
        }

        let (_never_cancel_tx, never_cancel_rx) = watch::channel(false);
        let mut cancel_rx = cancel.unwrap_or(never_cancel_rx);
        let download_id = format!("mcp-download-{}", uuid::Uuid::new_v4());

        crate::commands::sftp::stream_download_single_file(
            None,
            raw,
            &remote_handle,
            read_chunk,
            total,
            local_path,
            &download_id,
            &mut cancel_rx,
            true, // MCP 语义：覆盖已存在的本地文件
            on_progress,
        )
        .await?;

        Ok(TransferResult {
            success: true,
            bytes_transferred: total,
            duration_ms: start.elapsed().as_millis() as u64,
        })
    }

    /// 列出远端目录
    pub async fn list(
        &self,
        session_id: &str,
        remote_path: &str,
    ) -> Result<Vec<FileInfo>, AppError> {
        log::info!(
            "[MCP SFTP] list: session={}, remote={}",
            session_id,
            remote_path
        );

        let sftp = self.ssh_manager.open_sftp(session_id).await?;
        let mut dir = sftp
            .read_dir(remote_path)
            .await
            .map_err(|e| AppError::Ssh(format!("读取远端目录失败: {}", e)))?;

        let mut entries = Vec::new();
        while let Some(entry) = dir.next() {
            let metadata = entry.metadata();
            let name = entry.file_name();
            entries.push(FileInfo {
                path: format!("{}/{}", remote_path.trim_end_matches('/'), name),
                name,
                size: metadata.len(),
                is_dir: metadata.is_dir(),
                // russh-sftp 的元数据不保证给 mtime；给不出就报 null 而不是编一个 0
                modified: None,
                permissions: metadata.permissions.map(|p| format!("{:o}", p)),
            });
        }

        // 目录项顺序由远端给，排序保证同一目录两次调用结果稳定
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(entries)
    }

    /// 删除远端文件或目录
    pub async fn delete(
        &self,
        session_id: &str,
        remote_path: &str,
        recursive: bool,
    ) -> Result<(), AppError> {
        log::info!(
            "[MCP SFTP] delete: session={}, remote={}, recursive={}",
            session_id,
            remote_path,
            recursive
        );

        let sftp = self.ssh_manager.open_sftp(session_id).await?;

        if recursive {
            Self::remove_recursive(&sftp, remote_path).await
        } else {
            match sftp.remove_file(remote_path).await {
                Ok(()) => Ok(()),
                Err(file_err) => sftp.remove_dir(remote_path).await.map_err(|dir_err| {
                    AppError::Ssh(format!(
                        "删除失败（按文件删：{}；按空目录删：{}）",
                        file_err, dir_err
                    ))
                }),
            }
        }
    }

    /// 递归删除（显式装箱：async fn 递归需要已知大小的 Future）
    fn remove_recursive<'a>(
        sftp: &'a SftpSession,
        path: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), AppError>> + Send + 'a>>
    {
        Box::pin(async move {
            let mut dir = sftp
                .read_dir(path)
                .await
                .map_err(|e| AppError::Ssh(format!("读取远端目录失败: {}", e)))?;

            while let Some(entry) = dir.next() {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let child = format!("{}/{}", path.trim_end_matches('/'), name);
                if entry.metadata().is_dir() {
                    Self::remove_recursive(sftp, &child).await?;
                } else {
                    sftp.remove_file(child.as_str())
                        .await
                        .map_err(|e| AppError::Ssh(format!("删除文件 {} 失败: {}", child, e)))?;
                }
            }

            sftp.remove_dir(path)
                .await
                .map_err(|e| AppError::Ssh(format!("删除目录 {} 失败: {}", path, e)))
        })
    }
}
