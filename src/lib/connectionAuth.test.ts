import { beforeEach, describe, expect, it, vi } from "vitest";
import { recoverConnectionAuth } from "./connectionAuth";
import type { SavedConnection } from "./types";
import * as tauri from "./tauri";

vi.mock("./tauri", () => ({
  savePassword: vi.fn(),
  savePassphrase: vi.fn(),
  saveJumpPassword: vi.fn(),
  saveJumpPassphrase: vi.fn(),
}));
const saved: SavedConnection = {
  id: "c1",
  name: "a",
  host: "target",
  port: 22,
  username: "u",
  authMethod: "Password",
};
beforeEach(() => vi.clearAllMocks());

describe("连接和重连的密码恢复", () => {
  it.each([
    ["Password", "needs_password", "savePassword"],
    ["Password", "rejected", "savePassword"],
    ["PrivateKey", "needs_passphrase", "savePassphrase"],
    ["PrivateKey", "bad_passphrase", "savePassphrase"],
  ] as const)(
    "%s / %s 保存到正确位置后继续",
    async (authMethod, code, method) => {
      const prompt = vi.fn();
      const retry = vi.fn();
      expect(
        recoverConnectionAuth({
          error: { kind: "KeyAuth", message: "retry", data: { code } },
          connection: { ...saved, authMethod },
          privacyMode: false,
          prompt,
          retry,
        }),
      ).toBe(true);
      await prompt.mock.calls[0][0].onSubmit("secret");
      expect(tauri[method]).toHaveBeenCalledWith("c1", "secret");
      expect(retry).toHaveBeenCalledOnce();
    },
  );

  it("跳板机共用目标凭据时更新目标槽位，独立私钥则只更新跳板槽位", async () => {
    for (const method of ["withTarget", "PrivateKey"] as const) {
      const prompt = vi.fn();
      const retry = vi.fn();
      recoverConnectionAuth({
        error: {
          kind: "KeyAuth",
          message: "wrong",
          data: { code: "bad_passphrase", hop: "jump" },
        },
        connection: {
          ...saved,
          authMethod: "PrivateKey",
          useJump: true,
          jumpAuthMethod: method,
          jumpHost: "jump",
        },
        privacyMode: true,
        prompt,
        retry,
      });
      expect(prompt.mock.calls[0][0].title).toContain("跳板机");
      expect(prompt.mock.calls[0][0].description).not.toContain("jump");
      await prompt.mock.calls[0][0].onSubmit("secret");
      expect(
        method === "withTarget"
          ? tauri.savePassphrase
          : tauri.saveJumpPassphrase,
      ).toHaveBeenCalledWith("c1", "secret");
      expect(retry).toHaveBeenCalledWith(
        expect.objectContaining({ jump: method !== "withTarget" }),
      );
    }
  });

  it.each(["key_not_found", "key_unreadable", "unsupported_key", "rejected"])(
    "私钥 %s 不误问口令",
    (code) => {
      const prompt = vi.fn();
      expect(
        recoverConnectionAuth({
          error: { kind: "KeyAuth", message: "broken", data: { code } },
          connection: { ...saved, authMethod: "PrivateKey" },
          privacyMode: false,
          prompt,
          retry: vi.fn(),
        }),
      ).toBe(false);
      expect(prompt).not.toHaveBeenCalled();
    },
  );
});
