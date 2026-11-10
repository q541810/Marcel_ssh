use std::time::Duration;
use tokio::sync::watch;

/// 只计算实际执行时间；等待用户输入不触发超时或前台转后台。
#[derive(Debug, Clone)]
pub struct AuthWait(watch::Sender<bool>);

impl Default for AuthWait {
    fn default() -> Self {
        Self(watch::channel(false).0)
    }
}

impl AuthWait {
    pub fn set(&self, waiting: bool) {
        self.0.send_replace(waiting);
    }

    pub async fn sleep_active(&self, mut remaining: Duration) {
        let mut rx = self.0.subscribe();
        loop {
            let waiting = *rx.borrow_and_update();
            if waiting {
                if rx.changed().await.is_err() {
                    return;
                }
                continue;
            }
            let start = tokio::time::Instant::now();
            tokio::select! {
                biased;
                _ = rx.changed() => remaining = remaining.saturating_sub(start.elapsed()),
                _ = tokio::time::sleep(remaining) => return,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn prompt_time_does_not_consume_command_timeout() {
        let wait = AuthWait::default();
        let clock = wait.clone();
        let handle = tokio::spawn(async move { clock.sleep_active(Duration::from_secs(10)).await });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(3)).await;
        wait.set(true);
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(300)).await;
        assert!(!handle.is_finished());
        wait.set(false);
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(6)).await;
        assert!(!handle.is_finished());
        tokio::time::advance(Duration::from_secs(1)).await;
        handle.await.unwrap();
    }
}
