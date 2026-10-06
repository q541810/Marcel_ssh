//! 远端文件系统探测：SFTP stat 的薄封装。
//!
//! 「写前必须已读」预检要回答「远端目标存不存在」——这一问是机器相关的文件系统
//! 探测，不属于调度器的编排职责，所以从 `tool_dispatcher` 外迁到工具层单独立模块。

/// 远程目标是否存在（SFTP stat）。stat 失败按"不存在"处理：
/// 连接问题会由 write 自己报 SFTP 错误，这里不双重误拦新建。
pub(crate) async fn remote_file_exists(
    ssh: &crate::ssh::connection::SshManager,
    session_id: &str,
    path: &str,
) -> bool {
    match ssh.open_sftp(session_id).await {
        Ok(sftp) => sftp.metadata(path).await.is_ok(),
        Err(_) => false,
    }
}
