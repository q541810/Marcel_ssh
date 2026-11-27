//! MCP 请求生命周期登记。
//!
//! 每个 transport 实例各持一份：stdio 的请求 ID `1` 不能取消 HTTP 服务的
//! 另一个客户端请求。表只负责「在途 ID → 取消信号」，请求本身仍由
//! [`super::McpServer::handle_request_with_cancel`] 分发。

use serde_json::Value;
use tokio::sync::watch;

use crate::cancel::{CancellationRegistry, Registration};

/// 一条 MCP 连接/服务实例的在途请求表。
#[derive(Clone, Default)]
pub(crate) struct RequestTracker {
    registry: CancellationRegistry,
}

impl RequestTracker {
    /// 登记请求。同一个 ID 已在途时返回 `None`，调用方应拒绝新请求，
    /// 不能用 `register` 把旧请求的取消通道顶掉。
    pub(crate) fn try_register(&self, id: &Value) -> Option<RequestPermit> {
        let key = super::protocol::request_id_key(id);
        self.registry
            .try_register(&key)
            .map(|registration| RequestPermit { key, registration })
    }

    pub(crate) fn cancel(&self, id: &Value) -> bool {
        self.registry.cancel(&super::protocol::request_id_key(id))
    }

    /// 服务收尾：取消所有在途请求，让 worker 做协作清理。
    pub(crate) fn cancel_all(&self) -> usize {
        self.registry.cancel_all()
    }
}

/// 一次在途请求的凭据。随响应存活到写出/丢弃，避免响应排队期间
/// 同一个 ID 被提前复用。
pub(crate) struct RequestPermit {
    key: String,
    registration: Registration,
}

impl RequestPermit {
    pub(crate) fn receiver(&self) -> watch::Receiver<bool> {
        self.registration.receiver()
    }

    pub(crate) fn key(&self) -> &str {
        &self.key
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numeric_and_string_ids_do_not_collide() {
        let tracker = RequestTracker::default();
        let numeric = tracker.try_register(&json!(1)).expect("数字 ID");
        let string = tracker.try_register(&json!("1")).expect("字符串 ID 应独立");
        assert_ne!(numeric.key(), string.key());
        assert!(tracker.cancel(&json!(1)));
        assert!(!tracker.cancel(&json!(1)));
        assert!(tracker.cancel(&json!("1")));
    }

    #[test]
    fn duplicate_inflight_id_is_rejected_without_evicting_first() {
        let tracker = RequestTracker::default();
        let first = tracker.try_register(&json!("same")).expect("首次登记");
        assert!(tracker.try_register(&json!("same")).is_none());
        assert!(tracker.cancel(&json!("same")));
        drop(first);
    }

    #[test]
    fn cancel_all_signals_every_permit() {
        let tracker = RequestTracker::default();
        let a = tracker.try_register(&json!(1)).expect("a");
        let b = tracker.try_register(&json!(2)).expect("b");
        let ra = a.receiver();
        let rb = b.receiver();
        assert_eq!(tracker.cancel_all(), 2);
        assert!(*ra.borrow());
        assert!(*rb.borrow());
    }
}
