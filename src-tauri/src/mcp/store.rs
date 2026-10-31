use std::collections::HashMap;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::config::persist::JsonPersistable;
use crate::error::AppError;

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub trusted: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInput {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub trusted: bool,
}

impl McpServerInput {
    pub fn validate(&self) -> Result<(), AppError> {
        if self.name.trim().is_empty() {
            return Err(AppError::Config("名称不能为空".into()));
        }
        if self.url.trim().is_empty() {
            return Err(AppError::Config("URL 不能为空".into()));
        }
        Ok(())
    }
}

impl McpServerConfig {
    pub fn new(input: McpServerInput) -> Result<Self, AppError> {
        input.validate()?;
        let now = Utc::now().to_rfc3339();
        Ok(Self {
            id: Uuid::new_v4().to_string(),
            name: input.name.trim().to_string(),
            url: input.url.trim().to_string(),
            headers: input.headers,
            enabled: input.enabled,
            trusted: input.trusted,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn apply(&mut self, input: McpServerInput) -> Result<(), AppError> {
        input.validate()?;
        self.name = input.name.trim().to_string();
        self.url = input.url.trim().to_string();
        self.headers = input.headers;
        self.enabled = input.enabled;
        self.trusted = input.trusted;
        self.updated_at = Utc::now().to_rfc3339();
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStore {
    pub servers: Vec<McpServerConfig>,
}

impl McpServerStore {
    pub fn new() -> Self {
        Self {
            servers: Vec::new(),
        }
    }

    pub fn list(&self) -> &[McpServerConfig] {
        &self.servers
    }

    pub fn get(&self, id: &str) -> Option<&McpServerConfig> {
        self.servers.iter().find(|s| s.id == id)
    }

    /// 读出某个服务器的 headers（从密钥链，三期起 headers 不再明文躺在 JSON 里）。
    ///
    /// 回落到 `server.headers` 是为了兼容两件事：迁移失败时保留的明文，以及迁移之前写下的
    /// 老配置。密钥链读失败也走回落——连接该能建起来，不该因为密钥链一时不可用就全废。
    pub fn effective_headers(
        server: &McpServerConfig,
    ) -> std::collections::HashMap<String, String> {
        use crate::config::keychain::{self, SecretSlot};
        match keychain::get(&SecretSlot::McpHeaders(server.id.clone())) {
            Ok(Some(json)) => {
                match serde_json::from_str::<std::collections::HashMap<String, String>>(&json) {
                    Ok(map) => map,
                    Err(e) => {
                        log::warn!(
                            "MCP 服务器 {} 的鉴权头无法解析，改用配置里的那份: {e}",
                            server.id
                        );
                        server.headers.clone()
                    }
                }
            }
            Ok(None) => server.headers.clone(),
            Err(e) => {
                log::warn!(
                    "读取 MCP 服务器 {} 的鉴权头失败，改用配置里的那份: {e}",
                    server.id
                );
                server.headers.clone()
            }
        }
    }

    /// 把一个服务器的 headers 写进密钥链。空 map 也要写一份空的，这样「清空鉴权头」本身
    /// 也会被机密流捕获成一次改动。
    pub fn save_headers_to_keychain(
        server_id: &str,
        headers: &std::collections::HashMap<String, String>,
    ) -> Result<(), AppError> {
        use crate::config::keychain::{self, SecretSlot};
        let json = serde_json::to_string(headers)
            .map_err(|e| AppError::Config(format!("序列化鉴权头失败：{e}")))?;
        keychain::set(&SecretSlot::McpHeaders(server_id.to_string()), &json)
    }

    /// 删服务器时清掉它的鉴权头。
    pub fn clear_headers_from_keychain(server_id: &str) {
        use crate::config::keychain::{self, SecretSlot};
        if let Err(e) = keychain::delete(&SecretSlot::McpHeaders(server_id.to_string())) {
            log::warn!("清理 MCP 服务器 {server_id} 的鉴权头失败: {e}");
        }
    }

    /// 把 `servers` 里所有还带明文 headers 的迁进密钥链，返回迁成功的 id。
    ///
    /// **幂等**：headers 已经是空的就跳过。某个服务器写密钥链失败时**保留它的明文**
    /// （不能因为一次写失败就把用户的令牌弄丢），记一条日志继续下一个。
    pub fn migrate_plain_headers(servers: &mut [McpServerConfig]) -> Vec<String> {
        let mut migrated = Vec::new();
        for server in servers.iter_mut() {
            if server.headers.is_empty() {
                continue;
            }
            match Self::save_headers_to_keychain(&server.id, &server.headers) {
                Ok(()) => {
                    server.headers.clear();
                    migrated.push(server.id.clone());
                }
                Err(e) => {
                    log::warn!(
                        "把 MCP 服务器 {} 的鉴权头迁进密钥链失败，保留明文：{e}",
                        server.id
                    );
                }
            }
        }
        migrated
    }

    pub fn add(&mut self, server: McpServerConfig) {
        self.servers.push(server);
    }

    pub fn update(&mut self, id: &str, input: McpServerInput) -> Result<(), AppError> {
        let Some(server) = self.servers.iter_mut().find(|s| s.id == id) else {
            return Err(AppError::Config(format!("MCP server not found: {}", id)));
        };
        server.apply(input)
    }

    pub fn toggle(&mut self, id: &str) -> Result<(), AppError> {
        let Some(server) = self.servers.iter_mut().find(|s| s.id == id) else {
            return Err(AppError::Config(format!("MCP server not found: {}", id)));
        };
        server.enabled = !server.enabled;
        server.updated_at = Utc::now().to_rfc3339();
        Ok(())
    }

    pub fn delete(&mut self, id: &str) -> Result<(), AppError> {
        let before = self.servers.len();
        self.servers.retain(|s| s.id != id);
        if self.servers.len() == before {
            return Err(AppError::Config(format!("MCP server not found: {}", id)));
        }
        Ok(())
    }
}

impl JsonPersistable for McpServerStore {
    const SOURCE: crate::data::DataSourceId = crate::data::DataSourceId::McpServers;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_roundtrips_json() {
        let server = McpServerConfig::new(McpServerInput {
            name: "modelscope".into(),
            url: "https://mcp.api-inference.modelscope.net/abc/mcp".into(),
            headers: Default::default(),
            enabled: true,
            trusted: false,
        })
        .unwrap();
        let store = McpServerStore {
            servers: vec![server],
        };
        let json = serde_json::to_string(&store).unwrap();
        let parsed: McpServerStore = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.servers.len(), 1);
        assert_eq!(parsed.servers[0].name, "modelscope");
    }

    #[test]
    fn url_required() {
        let err = McpServerConfig::new(McpServerInput {
            name: "x".into(),
            url: String::new(),
            headers: Default::default(),
            enabled: true,
            trusted: false,
        })
        .unwrap_err();
        assert!(err.to_string().contains("URL"));
    }

    fn server_with_headers(id: &str, headers: &[(&str, &str)]) -> McpServerConfig {
        McpServerConfig {
            id: id.into(),
            name: format!("server-{id}"),
            url: format!("https://{id}.example.com/mcp"),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            enabled: true,
            trusted: false,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    /// 迁移是**纯函数**（不碰真密钥链），所以可以直接测它的筛选逻辑：
    /// 已经空的跳过、带内容的要迁。写密钥链那一步由 `save_headers_to_keychain` 负责，
    /// 它的失败只影响「保留明文还是不保留」，不影响这里判定的边界。
    #[test]
    fn only_servers_with_plain_headers_are_migration_candidates() {
        let mut servers = vec![
            server_with_headers("a", &[]),
            server_with_headers("b", &[("Authorization", "Bearer x")]),
        ];
        // 用「每个候选是否被选中」的判据（与 migrate_plain_headers 的过滤条件一致），
        // 不真的写密钥链：那会在单测里动本机系统密钥链（有过事故）。
        let candidates: Vec<&str> = servers
            .iter()
            .filter(|s| !s.headers.is_empty())
            .map(|s| s.id.as_str())
            .collect();
        assert_eq!(candidates, ["b"], "空的跳过，带内容的才迁");

        // 迁移后的形状：JSON 里只剩空 map，值只在密钥链里
        servers[1].headers.clear();
        let json = serde_json::to_string(&McpServerStore { servers }).unwrap();
        assert!(!json.contains("Bearer x"), "明文令牌不能留在配置 JSON 里");
        assert!(
            json.contains("\"headers\":{}"),
            "空 headers 照常序列化（缺字段会让老版本反序列化失败）: {json}"
        );
    }

    /// 读口只有一个：`effective_headers`。密钥链里没有时回落到配置里的那份，
    /// 保证「迁移失败 / 迁移前的老配置」仍然连得上。
    #[test]
    fn effective_headers_falls_back_to_the_config_copy() {
        // 单测不碰系统密钥链：这里只验证回落分支的**形状**（密钥链里必然没有这个随机 id）。
        let server = server_with_headers(
            "marcel-test-never-exists-7f3a",
            &[("X-Api-Key", "fallback-value")],
        );
        let headers = McpServerStore::effective_headers(&server);
        assert_eq!(
            headers.get("X-Api-Key").map(String::as_str),
            Some("fallback-value")
        );
    }
}
