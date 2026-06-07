use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::persist::JsonPersistable;
use crate::error::AppError;

/// A thread-safe, persistent config store that wraps a `JsonPersistable` type.
///
/// Provides convenient methods for loading, saving, and modifying config data
/// without needing to manually handle paths and file I/O.
pub struct ConfigStore<T: JsonPersistable> {
    path: PathBuf,
    data: Arc<RwLock<T>>,
}

impl<T: JsonPersistable + Send + Clone + 'static> ConfigStore<T> {
    /// Create a new ConfigStore with the given config directory.
    pub fn new(config_dir: &std::path::Path) -> Self {
        let path = T::default_file(config_dir);
        Self {
            path,
            data: Arc::new(RwLock::new(T::default())),
        }
    }

    /// Load data from disk. If the file doesn't exist, uses the default value.
    pub async fn load(&self) -> Result<(), AppError> {
        let new_data = tokio::task::spawn_blocking({
            let path = self.path.clone();
            move || T::load_from_path(&path)
        })
        .await
        .map_err(|e| AppError::Config(format!("Failed to spawn task: {}", e)))??;

        let mut data = self.data.write().await;
        *data = new_data;
        Ok(())
    }

    /// Save the current data to disk.
    pub async fn save(&self) -> Result<(), AppError> {
        let data = self.data.read().await;
        let path = self.path.clone();
        let data_clone = (*data).clone();

        tokio::task::spawn_blocking(move || data_clone.save_to_path(&path))
            .await
            .map_err(|e| AppError::Config(format!("Failed to spawn task: {}", e)))?
    }

    /// Get a read lock on the data.
    pub async fn read(&self) -> tokio::sync::RwLockReadGuard<'_, T> {
        self.data.read().await
    }

    /// Get a write lock on the data.
    pub async fn write(&self) -> tokio::sync::RwLockWriteGuard<'_, T> {
        self.data.write().await
    }

    /// Modify the data and save to disk in one operation.
    pub async fn update<F>(&self, f: F) -> Result<(), AppError>
    where
        F: FnOnce(&mut T),
    {
        let mut data = self.data.write().await;
        f(&mut *data);
        drop(data);
        self.save().await
    }

    /// Get the path to the config file.
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl<T: JsonPersistable> Clone for ConfigStore<T> {
    fn clone(&self) -> Self {
        Self {
            path: self.path.clone(),
            data: Arc::clone(&self.data),
        }
    }
}
