import { useEffect, useRef, useState } from "react";
import { Minus } from "lucide-react";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import type { ActiveInteractionPayload } from "@/lib/types";
import { sshRespondCredential } from "@/lib/tauri";
import { getErrorMessage } from "@/lib/errors";
import { formatInteractionSessionLabel } from "@/lib/privacy";
import { usePrivacyMode } from "@/hooks/usePrivacyMode";
import { registerBackHandler } from "@/mobile/backHandler";

export default function SudoPasswordDialog({
  interaction,
  onMinimize,
}: {
  interaction: ActiveInteractionPayload;
  onMinimize: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const privacyMode = usePrivacyMode();
  useEffect(() => {
    input.current?.focus();
    return registerBackHandler(onMinimize);
  }, [onMinimize]);

  const respond = async (value: string | null) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await sshRespondCredential(interaction.interactionId, value);
      setPassword("");
    } catch (err) {
      setError(getErrorMessage(err));
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal open title="sudo 密码" onClose={onMinimize}>
      <form
        className="space-y-4 p-4 pt-0"
        onSubmit={(e) => {
          e.preventDefault();
          if (password) void respond(password);
        }}
      >
        <div className="flex items-start gap-2 text-body text-fg-secondary">
          <div className="min-w-0 flex-1 break-words">
            <p>
              {formatInteractionSessionLabel(
                interaction.sessionTarget,
                privacyMode,
              )}
            </p>
            {interaction.conversationTitle && (
              <p className="text-meta text-fg-tertiary">
                {interaction.conversationTitle}
              </p>
            )}
          </div>
          <button
            type="button"
            title="收起，稍后输入"
            aria-label="收起"
            onClick={onMinimize}
            className="hit-area focus-ring h-7 w-7 shrink-0 rounded-md hover:bg-fill-soft"
          >
            <Minus size={16} className="mx-auto" />
          </button>
        </div>
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all text-body text-fg">
          {interaction.credential?.command}
        </pre>
        <label className="block space-y-2 text-body text-fg">
          <span>{interaction.credential?.username} 的账户密码</span>
          <input
            ref={input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            autoComplete="off"
            className="field w-full rounded-lg px-3 py-2 text-read"
            aria-invalid={!!error || interaction.credential?.rejected}
          />
        </label>
        <p className="text-meta text-fg-tertiary">
          {interaction.credential?.persist
            ? "密码会加密保存在本设备，下次自动使用；不会覆盖你保存的登录密码。"
            : "仅在本次连接记住。断线后清除。"}
        </p>
        {(error || interaction.credential?.rejected) && (
          <p role="alert" className="text-body text-red-400">
            {error || "上次密码未被接受，请重新输入。"}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => void respond(null)}
          >
            取消输入
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !password}>
            {busy ? "提交中…" : "继续执行"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
