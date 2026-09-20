//! 私钥库相关的 Tauri 命令。
//!
//! 安全：**导入之后私钥正文不再回到前端**。这里返回的 `StoredKeyMeta` 只含名字、
//! 算法、指纹、来源这些能给人看的东西；连接时由 Rust 侧自行从库里解密取用
//! （见 `ssh::key_store::resolve_pem`）。
//!
//! 导入来源有三种，全都走这里收口：
//! - 桌面：普通文件路径（系统文件对话框给的）
//! - Android：`content://` URI（系统文件选择器给的取件凭据，必须经 ContentResolver 读）
//! - 两端：用户直接粘贴的私钥文本

use tauri::AppHandle;
use tokio::io::AsyncReadExt;

use crate::commands::agent_attachment::local_file_name;
use crate::commands::sftp::{open_content_uri_file, ContentOpenMode};
use crate::error::AppError;
use crate::ssh::key_material;
use crate::ssh::key_store::{self, OriginStatus, StoredKeyMeta};
use crate::util::{is_content_uri, validate_local_path};

/// 导入来自文件的私钥。
///
/// `name` 为空时用文件名兜底（Android 上经 ContentResolver 查真实显示名，
/// `content://` 的最后一段是 document id，不能当名字用）。
#[tauri::command]
pub async fn ssh_key_import_file(
    app: AppHandle,
    path: String,
    name: Option<String>,
    passphrase: Option<String>,
) -> Result<StoredKeyMeta, AppError> {
    let path = validate_local_path(&path)?;
    let text = read_local_key_text(&app, &path).await?;

    let display_name = match name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) {
        Some(n) => n,
        None => local_file_name(&path).await.unwrap_or_default(),
    };

    // 只有真实文件路径才记来源：content:// 的授权是本次会话的，
    // 存下来过一会儿就是一条读不了的死链接，反而会误导"来源变了"的提醒
    let origin = if is_content_uri(&path) {
        None
    } else {
        Some(path.as_str())
    };
    key_store::import_text(&text, &display_name, origin, passphrase.as_deref())
}

/// 导入用户粘贴的私钥文本。
#[tauri::command]
pub fn ssh_key_import_text(
    content: String,
    name: Option<String>,
    passphrase: Option<String>,
) -> Result<StoredKeyMeta, AppError> {
    let display_name = name.map(|n| n.trim().to_string()).unwrap_or_default();
    key_store::import_text(&content, &display_name, None, passphrase.as_deref())
}

/// 列出已导入的私钥（按导入顺序）。
#[tauri::command]
pub fn ssh_key_list() -> Vec<StoredKeyMeta> {
    key_store::list()
}

/// 重命名一把已导入的私钥。
#[tauri::command]
pub fn ssh_key_rename(id: String, name: String) -> Result<StoredKeyMeta, AppError> {
    key_store::rename(&id, &name)
}

/// 删除一把已导入的私钥。
///
/// 注意语义：一把密钥可以被多条连接共用，所以这里**只删密钥**，
/// 不会去动任何连接配置——那些连接下次连接时会明确提示"引用的密钥已被删除"。
#[tauri::command]
pub fn ssh_key_delete(id: String) -> Result<(), AppError> {
    key_store::delete(&id)
}

/// 这把私钥的导入来源现在是什么样：还在不在、还是不是同一把。
///
/// 用途：用户重新生成了密钥之后，库里那份还是旧的——连接会以"服务器拒绝"收场，
/// 而他明明把新公钥加上去了。返回 `None` 表示这条没有来源可比（粘贴导入的、
/// 或来源读不了），前端就不显示这一行。
#[tauri::command]
pub fn ssh_key_origin_status(id: String) -> Result<Option<OriginStatus>, AppError> {
    key_store::origin_status(&id)
}

/// 用来源文件的当前内容刷新库里那一份（同一个条目，原地换掉，连接不用改）。
///
/// 新内容带密码时要一并给密码：解不开就没法确认换成功，也无法给出新的指纹。
#[tauri::command]
pub fn ssh_key_refresh_from_origin(
    id: String,
    passphrase: Option<String>,
) -> Result<Option<StoredKeyMeta>, AppError> {
    key_store::replace_from_origin(&id, passphrase.as_deref())
}

/// 读取私钥文本：`content://` 走 ContentResolver，其余按普通路径读。
async fn read_local_key_text(app: &AppHandle, path: &str) -> Result<String, AppError> {
    if !is_content_uri(path) {
        // 普通路径交给 key_material：大小上限、目录判定、`~` 展开、中文报错都在那里
        return key_material::read_key_file(path);
    }

    let mut file = open_content_uri_file(app, path.to_string(), ContentOpenMode::Read).await?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .await
        .map_err(|e| AppError::Ssh(format!("读取所选文件失败：{}", e)))?;

    if buf.len() > key_material::MAX_KEY_BYTES {
        return Err(AppError::KeyAuth {
            code: crate::error::KeyAuthCode::UnsupportedKey,
            message: "这个文件太大，不像是私钥".into(),
        });
    }
    key_material::text_from_bytes(buf)
}
