import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectFlow, type ConnectFlowDeps } from "./connectFlow";
import type { SavedConnection } from "./types";

vi.mock("./tauri", () => ({
  hasPassword: vi.fn().mockResolvedValue(true),
  hasPassphrase: vi.fn().mockResolvedValue(true),
  savePassword: vi.fn().mockResolvedValue(undefined),
  savePassphrase: vi.fn().mockResolvedValue(undefined),
  saveJumpPassword: vi.fn().mockResolvedValue(undefined),
  saveJumpPassphrase: vi.fn().mockResolvedValue(undefined),
  listKeys: vi.fn().mockResolvedValue([]),
}));
import * as tauri from "./tauri";

const conn: SavedConnection = {
  id: "server",
  name: "Server",
  host: "target",
  port: 22,
  username: "deploy",
  authMethod: "PrivateKey",
  keyId: "key",
};
const failure = (code: string, hop?: string) => ({
  kind: "KeyAuth",
  message: "请重新输入",
  data: { code, hop },
});
function setup() {
  const deps: ConnectFlowDeps = {
    connect: vi.fn().mockResolvedValue("session"),
    connectWithSavedPassword: vi.fn().mockResolvedValue("session"),
    connectWithSavedPassphrase: vi.fn().mockResolvedValue("session"),
    promptPassword: vi.fn(),
    promptMismatch: vi.fn(),
    onSessionEstablished: vi.fn(),
    setLocalError: vi.fn(),
    privacyMode: false,
    beforeAttempt: vi.fn(),
    beforeSessionConnect: vi.fn().mockResolvedValue(undefined),
    afterAttempt: vi.fn(),
    reportFailure: vi.fn(),
    onDebugConnect: vi.fn(),
  };
  return { deps, flow: createConnectFlow(deps) };
}
beforeEach(() => vi.clearAllMocks());

describe("连接中的凭据恢复", () => {
  it("补输错误后可继续补输，直到连接成功", async () => {
    const { deps, flow } = setup();
    vi.mocked(deps.connect).mockRejectedValueOnce(failure("bad_passphrase"));
    await flow.doConnect(conn, undefined, "wrong");
    expect(deps.promptPassword).toHaveBeenCalledOnce();
    await vi.mocked(deps.promptPassword).mock.calls[0][0].onSubmit("right");
    expect(tauri.savePassphrase).toHaveBeenCalledWith("server", "right");
    expect(deps.onSessionEstablished).toHaveBeenCalledWith("server", "session");
    expect(deps.reportFailure).not.toHaveBeenCalled();
  });

  it("确认主机指纹后的重试仍能补输口令", async () => {
    const { deps, flow } = setup();
    vi.mocked(deps.connectWithSavedPassphrase)
      .mockRejectedValueOnce({
        kind: "HostKeyMismatch",
        message: "changed",
        data: {
          host: "target",
          port: 22,
          storedAlgorithm: "ed25519",
          storedFingerprint: "old",
          presentedAlgorithm: "ed25519",
          presentedFingerprint: "new",
        },
      })
      .mockRejectedValueOnce(failure("bad_passphrase"));
    await flow.handleConnect(conn);
    await vi.mocked(deps.promptMismatch).mock.calls[0][0].onTrust();
    expect(deps.promptPassword).toHaveBeenCalledOnce();
  });

  it("跳板机缺少密码时，只保存跳板机密码后继续原连接", async () => {
    const { deps, flow } = setup();
    vi.mocked(deps.connect).mockRejectedValueOnce(
      failure("needs_password", "jump"),
    );
    const jumped = {
      ...conn,
      useJump: true,
      jumpHost: "jump",
      jumpUsername: "proxy",
      jumpAuthMethod: "Password" as const,
    };
    await flow.doConnect(jumped, undefined, "target-passphrase");
    expect(deps.promptPassword).toHaveBeenCalledOnce();
    const prompt = vi.mocked(deps.promptPassword).mock.calls[0][0];
    expect(prompt.title).toContain("跳板机");
    await prompt.onSubmit("jump-password");
    expect(tauri.saveJumpPassword).toHaveBeenCalledWith(
      "server",
      "jump-password",
    );
    expect(tauri.savePassword).not.toHaveBeenCalled();
    expect(tauri.savePassphrase).not.toHaveBeenCalled();
    expect(deps.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        authMethod: expect.objectContaining({
          passphrase: "target-passphrase",
        }),
      }),
    );
  });
});
