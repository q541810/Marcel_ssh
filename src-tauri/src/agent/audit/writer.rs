use std::path::PathBuf;

use chrono::{NaiveDate, Utc};
use tokio::fs::{self, File, OpenOptions};
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::Mutex;

use super::AuditEntry;

pub(super) struct WriterState {
    pub current_date: NaiveDate,
    pub file: BufWriter<File>,
    pub path: PathBuf,
}

pub(super) struct JsonlWriter {
    pub(super) dir: PathBuf,
    pub(super) inner: Mutex<WriterState>,
}

fn file_name_for(date: NaiveDate) -> String {
    format!("agent-audit-{}.jsonl", date.format("%Y%m%d"))
}

async fn open_file(dir: &PathBuf, date: NaiveDate) -> std::io::Result<(BufWriter<File>, PathBuf)> {
    let path = dir.join(file_name_for(date));
    let existed = fs::try_exists(&path).await.unwrap_or(false);
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await?;
    #[cfg(unix)]
    {
        if !existed {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o600);
            let _ = std::fs::set_permissions(&path, perms);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = existed;
    }
    Ok((BufWriter::new(file), path))
}

impl JsonlWriter {
    pub(super) async fn open(dir: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&dir).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o700);
            let _ = std::fs::set_permissions(&dir, perms);
        }
        let today = Utc::now().date_naive();
        let (file, path) = open_file(&dir, today).await?;
        Ok(Self {
            dir,
            inner: Mutex::new(WriterState {
                current_date: today,
                file,
                path,
            }),
        })
    }

    pub(super) async fn append(&self, entry: &AuditEntry) -> std::io::Result<()> {
        let mut guard = self.inner.lock().await;
        let mut line = serde_json::to_string(entry)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        line.push('\n');
        guard.file.write_all(line.as_bytes()).await?;
        guard.file.flush().await?;
        let today = Utc::now().date_naive();
        if today != guard.current_date {
            guard.file.flush().await?;
            let (file, path) = open_file(&self.dir, today).await?;
            guard.current_date = today;
            guard.file = file;
            guard.path = path;
        }
        Ok(())
    }

    #[allow(dead_code)]
    pub(super) async fn current_path(&self) -> PathBuf {
        self.inner.lock().await.path.clone()
    }

    #[cfg(test)]
    pub(super) async fn set_date_for_test(&self, date: NaiveDate) -> std::io::Result<()> {
        let mut guard = self.inner.lock().await;
        guard.file.flush().await?;
        let (file, path) = open_file(&self.dir, date).await?;
        guard.current_date = date;
        guard.file = file;
        guard.path = path;
        Ok(())
    }
}
