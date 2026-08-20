//! Plugin capability authorization — single source of truth.
//!
//! Used by both the event IPC channel (`pluginIpc.ts` mirrors this logic) and
//! the HTTP API channel (`plugin_webview.rs::handle_plugin_api`). Keeping the
//! logic here ensures both channels enforce the same three-layer policy:
//!   1. plugin is enabled (not in `disabled_plugins`)
//!   2. plugin manifest declares the required capability
//!   3. user has authorized the capability for this plugin
//!      (plugin absent from `authorized_capabilities` → all declared caps ok)

use crate::config::settings::AppSettings;
use crate::error::AppError;
use crate::plugins::manifest::PluginManifest;

/// Outcome of an authorization check. Carries a diagnostic reason on denial
/// so callers (event IPC response, HTTP API JSON error, logs) can surface it
/// without re-deriving it.
#[derive(Debug, Clone)]
pub enum AuthResult {
    Authorized,
    Denied { reason: String },
}

impl AuthResult {
    pub fn ok(&self) -> bool {
        matches!(self, AuthResult::Authorized)
    }

    pub fn reason(&self) -> Option<&str> {
        match self {
            AuthResult::Denied { reason } => Some(reason),
            AuthResult::Authorized => None,
        }
    }
}

/// Check whether `plugin_id` may invoke a command requiring `capability`.
///
/// `manifest` is the plugin's declared manifest (capabilities field is the
/// declaration surface). `settings` is the live in-memory `AppSettings`.
pub fn authorize(
    plugin_id: &str,
    capability: &str,
    manifest: Option<&PluginManifest>,
    settings: &AppSettings,
) -> AuthResult {
    // Layer 1: plugin enabled
    if settings.disabled_plugins.iter().any(|id| id == plugin_id) {
        return AuthResult::Denied {
            reason: format!("plugin \"{}\" is disabled", plugin_id),
        };
    }

    // Layer 2: manifest declares the capability
    let manifest = match manifest {
        Some(m) => m,
        None => {
            return AuthResult::Denied {
                reason: format!("manifest not found for plugin \"{}\"", plugin_id),
            }
        }
    };

    if !manifest.capabilities.iter().any(|c| c == capability) {
        return AuthResult::Denied {
            reason: format!(
                "capability \"{}\" not declared by \"{}\" (declared: {:?})",
                capability, plugin_id, manifest.capabilities
            ),
        };
    }

    // Layer 3: user authorization
    // Plugin absent from map → all declared capabilities are authorized (backward compat).
    // Plugin present in map → only listed capabilities are authorized.
    if let Some(authorized_list) = settings.authorized_capabilities.get(plugin_id) {
        if !authorized_list.iter().any(|c| c == capability) {
            return AuthResult::Denied {
                reason: format!(
                    "capability \"{}\" not in authorizedCapabilities for \"{}\" (authorized: {:?})",
                    capability, plugin_id, authorized_list
                ),
            };
        }
    }

    AuthResult::Authorized
}

/// Convenience wrapper: authorize or return an `AppError`.
pub fn authorize_or_err(
    plugin_id: &str,
    capability: &str,
    manifest: Option<&PluginManifest>,
    settings: &AppSettings,
) -> Result<(), AppError> {
    match authorize(plugin_id, capability, manifest, settings) {
        AuthResult::Authorized => Ok(()),
        AuthResult::Denied { reason } => Err(AppError::Other(reason)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_with(caps: &[&str]) -> PluginManifest {
        PluginManifest {
            id: "test-plugin".into(),
            name: "Test".into(),
            version: "1.0.0".into(),
            publisher: String::new(),
            description: "test".into(),
            capabilities: caps.iter().map(|s| s.to_string()).collect(),
            views: vec![],
            agent_tools: vec![],
            injections: vec![],
            config_view: None,
            system_prompt_section: None,
            min_app_version: None,
            preserve_paths: vec![],
        }
    }

    fn settings_with(disabled: &[&str], authorized: &[(&str, &[&str])]) -> AppSettings {
        let mut s = AppSettings::default();
        s.disabled_plugins = disabled.iter().map(|d| d.to_string()).collect();
        s.authorized_capabilities = authorized
            .iter()
            .map(|(k, v)| (k.to_string(), v.iter().map(|c| c.to_string()).collect()))
            .collect();
        s
    }

    #[test]
    fn disabled_plugin_denied() {
        let m = manifest_with(&["fs.read"]);
        let s = settings_with(&["test-plugin"], &[]);
        assert!(!authorize("test-plugin", "fs.read", Some(&m), &s).ok());
    }

    #[test]
    fn undeclared_capability_denied() {
        let m = manifest_with(&["fs.read"]);
        let s = settings_with(&[], &[]);
        let r = authorize("test-plugin", "ssh.exec", Some(&m), &s);
        assert!(!r.ok());
        assert!(r.reason().unwrap().contains("not declared"));
    }

    #[test]
    fn declared_and_not_in_auth_map_authorized() {
        let m = manifest_with(&["fs.read"]);
        let s = settings_with(&[], &[]);
        assert!(authorize("test-plugin", "fs.read", Some(&m), &s).ok());
    }

    #[test]
    fn declared_but_revoked_by_user_denied() {
        let m = manifest_with(&["fs.read", "fs.write"]);
        // user authorized only fs.read for this plugin
        let s = settings_with(&[], &[("test-plugin", &["fs.read"])]);
        let r = authorize("test-plugin", "fs.write", Some(&m), &s);
        assert!(!r.ok());
        assert!(r
            .reason()
            .unwrap()
            .contains("not in authorizedCapabilities"));
    }

    #[test]
    fn declared_and_user_authorized_ok() {
        let m = manifest_with(&["fs.read", "fs.write"]);
        let s = settings_with(&[], &[("test-plugin", &["fs.read", "fs.write"])]);
        assert!(authorize("test-plugin", "fs.write", Some(&m), &s).ok());
    }

    #[test]
    fn missing_manifest_denied() {
        let s = settings_with(&[], &[]);
        let r = authorize("ghost", "fs.read", None, &s);
        assert!(!r.ok());
        assert!(r.reason().unwrap().contains("manifest not found"));
    }
}
