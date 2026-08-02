//! Command → capability single source of truth.
//!
//! Every command a plugin can invoke (via event IPC, HTTP API, or local
//! handler) maps to exactly one capability string. This module owns that
//! mapping so the three enforcement points (event IPC `isAuthorized`, HTTP
//! API `handle_plugin_api`, local handler `required_capability`) never drift.
//!
//! The frontend mirrors this map at startup via the `plugin_capability_map`
//! Tauri command — see `pluginIpc.ts`.

use std::collections::HashMap;

/// The single source of truth: `(command_alias, capability)` pairs.
///
/// A command may appear multiple times under different aliases (e.g.
/// `fs.read` and `plugin_fs_read` both map to `fs.read`). A capability
/// may be the target of multiple commands. Every capability is also
/// self-mapped (e.g. `("ssh.list", "ssh.list")`) so plugins that send
/// the capability name directly as a command resolve correctly.
pub const COMMAND_CAPABILITY_MAP: &[(&str, &str)] = &[
    // ── ssh.list ──
    ("ssh.list", "ssh.list"),
    ("session.active", "ssh.list"),
    ("session.info", "ssh.list"),
    ("connection.info", "ssh.list"),
    ("connection.list", "ssh.list"),
    ("ssh_list_sessions", "ssh.list"),
    ("host_port", "ssh.list"),
    // ── ssh.exec ──
    ("ssh.exec", "ssh.exec"),
    ("ssh_exec", "ssh.exec"),
    // ── sftp.read ──
    ("sftp.read", "sftp.read"),
    ("sftp_read_file", "sftp.read"),
    // ── sftp.write ──
    ("sftp.write", "sftp.write"),
    ("sftp_write_file", "sftp.write"),
    // ── fs.read ──
    ("fs.read", "fs.read"),
    ("plugin_fs_read", "fs.read"),
    ("config.read", "fs.read"),
    // ── fs.write ──
    ("fs.write", "fs.write"),
    ("fs.append", "fs.write"),
    ("plugin_fs_write", "fs.write"),
    ("config.write", "fs.write"),
    ("config.saved", "fs.write"),
    // ── net.request ──
    ("net.request", "net.request"),
    ("plugin_http_request", "net.request"),
    // ── notification ──
    ("notification", "notification"),
    ("plugin_send_notification", "notification"),
    // ── events ──
    ("events", "events"),
    ("events.subscribe", "events"),
    ("events.unsubscribe", "events"),
    // ── window.create (basic window lifecycle; shared by create/show/hide/
    //    close/set_position/set_size/focus/set_ignore_cursor_events) ──
    ("window.create", "window.create"),
    ("window.show", "window.create"),
    ("window.hide", "window.create"),
    ("window.close", "window.create"),
    ("window.set_position", "window.create"),
    ("window.set_size", "window.create"),
    ("window.focus", "window.create"),
    ("window.set_ignore_cursor_events", "window.create"),
    // ── window.always_on_top (sensitive: cross-app overlay) ──
    ("window.always_on_top", "window.always_on_top"),
    ("window.set_always_on_top", "window.always_on_top"),
    // ── window.transparent (sensitive: invisible/overlay windows) ──
    ("window.transparent", "window.transparent"),
    // ── window.skip_taskbar (sensitive: hidden background presence) ──
    ("window.skip_taskbar", "window.skip_taskbar"),
    // ── context_menu (native right-click menu registration) ──
    ("context_menu", "context_menu"),
    ("menu.register", "context_menu"),
    ("menu.update", "context_menu"),
    ("menu.unregister", "context_menu"),
    ("menu.popup", "context_menu"),
];

/// Look up the capability required for `cmd`. Returns `None` for unknown
/// commands (the caller should reject the command entirely in that case).
pub fn capability_for(cmd: &str) -> Option<&'static str> {
    COMMAND_CAPABILITY_MAP
        .iter()
        .find(|(c, _)| *c == cmd)
        .map(|(_, cap)| *cap)
}

/// Serialize the map as `HashMap<String, String>` for the frontend.
pub fn as_hash_map() -> HashMap<String, String> {
    COMMAND_CAPABILITY_MAP
        .iter()
        .map(|(cmd, cap)| (cmd.to_string(), cap.to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_commands_resolve() {
        assert_eq!(capability_for("fs.read"), Some("fs.read"));
        assert_eq!(capability_for("fs.append"), Some("fs.write"));
        assert_eq!(capability_for("session.active"), Some("ssh.list"));
        assert_eq!(capability_for("ssh_exec"), Some("ssh.exec"));
        assert_eq!(capability_for("config.saved"), Some("fs.write"));
        assert_eq!(capability_for("host_port"), Some("ssh.list"));
    }

    #[test]
    fn unknown_command_returns_none() {
        assert_eq!(capability_for("totally.fake"), None);
        assert_eq!(capability_for(""), None);
    }

    #[test]
    fn every_capability_is_self_mapped() {
        // Collect all unique capabilities
        let caps: Vec<&str> = COMMAND_CAPABILITY_MAP
            .iter()
            .map(|(_, cap)| *cap)
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        for cap in caps {
            assert_eq!(
                capability_for(cap),
                Some(cap),
                "capability \"{}\" must self-map (\"{}\", \"{}\")",
                cap,
                cap,
                cap
            );
        }
    }

    #[test]
    fn as_hash_map_roundtrips() {
        let m = as_hash_map();
        assert_eq!(m.get("fs.read"), Some(&"fs.read".to_string()));
        assert_eq!(m.get("ssh_exec"), Some(&"ssh.exec".to_string()));
        // Every entry in the const should be in the HashMap
        for (cmd, cap) in COMMAND_CAPABILITY_MAP {
            assert_eq!(m.get(*cmd), Some(&cap.to_string()));
        }
    }
}
