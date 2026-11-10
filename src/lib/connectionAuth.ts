import { getErrorMessage, parseAppError } from "./errors";
import { formatConnLabel } from "./privacy";
import * as tauri from "./tauri";
import type { SavedConnection } from "./types";

export interface CredentialPrompt {
  title: string;
  description: string;
  error?: string;
  onSubmit: (password: string) => void | Promise<void>;
}

export interface ConnectionCredential {
  kind: "password" | "passphrase";
  jump: boolean;
  value: string;
}

/** 连接与重连共用：错误决定问哪台主机、保存哪个槽位，调用方只负责继续尝试。 */
export function recoverConnectionAuth(options: {
  error: unknown;
  connection: SavedConnection;
  privacyMode: boolean;
  prompt: (config: CredentialPrompt) => void;
  retry: (credential: ConnectionCredential) => Promise<void>;
  onSaveError?: (error: unknown) => void;
}): boolean {
  const {
    error,
    connection: conn,
    privacyMode,
    prompt,
    retry,
    onSaveError,
  } = options;
  const parsed = parseAppError(error);
  if (parsed.kind !== "KeyAuth") return false;
  const hopIsJump = parsed.data?.hop === "jump";
  const jump =
    hopIsJump &&
    !!conn.useJump &&
    !!conn.jumpAuthMethod &&
    conn.jumpAuthMethod !== "withTarget";
  const method = jump ? conn.jumpAuthMethod : conn.authMethod;
  const code = parsed.data?.code;
  const kind =
    method === "Password" && (code === "needs_password" || code === "rejected")
      ? "password"
      : method === "PrivateKey" &&
          (code === "needs_passphrase" || code === "bad_passphrase")
        ? "passphrase"
        : null;
  if (!kind) return false;
  const title = `${hopIsJump ? "跳板机" : ""}${kind === "password" ? "SSH 密码" : "私钥密码"}`;
  const label = formatConnLabel(
    hopIsJump ? (conn.jumpUsername ?? conn.username) : conn.username,
    hopIsJump ? (conn.jumpHost ?? conn.host) : conn.host,
    hopIsJump ? (conn.jumpPort ?? 22) : conn.port,
    privacyMode,
  );
  const rejected = code === "rejected" || code === "bad_passphrase";
  prompt({
    title,
    description:
      `连接到 ${label}。密码会加密保存在本设备，下次自动使用。` +
      (code === "rejected" ? "上次保存的密码被服务器拒绝，请输入新的。" : ""),
    error: rejected ? getErrorMessage(error) : undefined,
    onSubmit: async (value) => {
      try {
        if (jump) {
          if (kind === "password") await tauri.saveJumpPassword(conn.id, value);
          else await tauri.saveJumpPassphrase(conn.id, value);
        } else if (kind === "password")
          await tauri.savePassword(conn.id, value);
        else await tauri.savePassphrase(conn.id, value);
      } catch (err) {
        if (onSaveError) {
          onSaveError(err);
          return;
        }
        throw err;
      }
      await retry({ kind, jump, value });
    },
  });
  return true;
}
