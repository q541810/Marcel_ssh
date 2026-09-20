import { useCallback, useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import * as tauri from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import { describeAlgorithm, keyAuthCode, shortFingerprint } from '@/lib/privateKey';
import { withForegroundKeepAlive } from '@/mobile/mobileBridge';
import { useSettingsStore } from '@/stores/settingsStore';
import type { KeyOriginStatus, StoredKeyMeta } from '@/lib/types';
import Button from '@/components/ui/Button';

interface Props {
  /** 当前选中的私钥 id */
  selectedId?: string;
  /** 选中回调；传 undefined 表示"不用库里的密钥" */
  onSelect: (id: string | undefined) => void;
  /** 有几条连接在用这把密钥（删除前要提醒清楚） */
  usageOf?: (keyId: string) => number;
  /**
   * 只影响尺寸与按压反馈：触屏需要约 44px 的触控目标、按下即高亮；
   * 桌面用指针，可以更紧凑。逻辑两档完全一致。
   */
  variant?: 'desktop' | 'mobile';
}

type ImportSource =
  | { kind: 'file'; path: string }
  | { kind: 'text'; content: string; name: string }
  /** 用来源文件刷新已有条目（原地换，连接不用改） */
  | { kind: 'refresh'; id: string };

/**
 * 私钥库的界面：列出已导入的私钥、导入新的（选文件 / 粘贴内容）、重命名、删除。
 *
 * 桌面与移动端共用这一个组件，外层分别套 `Modal` 与 `MobileSheet`——私钥相关的
 * 交互逻辑只写一份，避免两端行为漂移（这正是此前"移动端注释写着 same semantics
 * as desktop、实际桌面根本没有那个字段"的成因）。
 *
 * 关于密码：私钥自带密码时**在导入这一步就当场要**。因为解不开就拿不到指纹，
 * 用户也就没法核对"导入的到底是不是我要的那把钥匙"。
 */
export default function KeyManager({
  selectedId,
  onSelect,
  usageOf,
  variant = 'desktop',
}: Props) {
  const keepAliveEnabled = useSettingsStore(
    (s) => s.settings.mobileBackgroundSettings.keepAliveEnabled,
  );

  const [keys, setKeys] = useState<StoredKeyMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 有来源的条目：原文件还在不在、还是不是同一把 */
  const [origins, setOrigins] = useState<Record<string, KeyOriginStatus>>({});

  // 粘贴表单
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteName, setPasteName] = useState('');
  const [pasteContent, setPasteContent] = useState('');

  // 等待密码的导入（来源已就绪，只差密码）
  const [pending, setPending] = useState<ImportSource | null>(null);
  const [pendingPassphrase, setPendingPassphrase] = useState('');
  const [pendingHint, setPendingHint] = useState<string | null>(null);

  // 行内操作
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await tauri.listKeys();
      setKeys(list);
      // 顺带查一遍"原文件还对不对"，只对真有来源的条目查
      const withOrigin = list.filter((k) => k.originPath);
      if (withOrigin.length === 0) {
        setOrigins({});
        return;
      }
      const statuses = await Promise.all(
        withOrigin.map(async (key) => {
          try {
            const status = await tauri.keyOriginStatus(key.id);
            return status ? ([key.id, status] as const) : null;
          } catch {
            // 单条查不了不该把整个列表带崩
            return null;
          }
        }),
      );
      const next: Record<string, KeyOriginStatus> = {};
      for (const entry of statuses) {
        if (entry) next[entry[0]] = entry[1];
      }
      setOrigins(next);
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }, []);

  // 触屏：行高与按压反馈按手指来（按下即亮，不等抬起）
  const touch = variant === 'mobile';
  const rowClass = touch
    ? 'min-h-[52px] rounded-xl px-3 py-3 transition-colors active:bg-zinc-800/70'
    : 'rounded-lg px-3 py-2 transition-colors';
  const rowActionClass = touch
    ? 'shrink-0 rounded-lg px-3 py-2 text-sm transition-colors active:bg-zinc-700/60'
    : 'shrink-0 rounded px-1.5 py-1 text-xs transition-colors';
  const fieldClass = touch
    ? 'w-full rounded-xl border border-zinc-700 bg-zinc-800 px-3 py-3 text-base text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-indigo-500'
    : 'w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-indigo-500';
  const inlineBtnClass = touch ? 'py-2.5 text-sm' : 'py-1.5 text-sm';
  const smallBtnClass = touch ? 'py-2 text-sm' : 'py-1 text-xs';

  useEffect(() => {
    void reload();
  }, [reload]);

  const runImport = useCallback(
    async (source: ImportSource, passphrase?: string) => {
      setBusy(true);
      setError(null);
      try {
        const meta =
          source.kind === 'file'
            ? await tauri.importKeyFile(source.path, undefined, passphrase)
            : source.kind === 'text'
              ? await tauri.importKeyText(
                  source.content,
                  source.name || undefined,
                  passphrase,
                )
              : await tauri.refreshKeyFromOrigin(source.id, passphrase);
        setPending(null);
        setPendingPassphrase('');
        setPendingHint(null);
        setPasteOpen(false);
        setPasteContent('');
        setPasteName('');
        await reload();
        // 刷新已有条目时 id 不变，别去动用户在表单里的选择
        if (meta && source.kind !== 'refresh') onSelect(meta.id);
      } catch (e) {
        const code = keyAuthCode(e);
        if (code === 'needs_passphrase' || code === 'bad_passphrase') {
          // 只在这两种情况下追问密码——其余问题（文件不存在、格式不支持）说了就要照做
          setPending(source);
          setPendingHint(
            code === 'bad_passphrase' ? '密码不对，请重新输入。' : getErrorMessage(e),
          );
        } else {
          setError(getErrorMessage(e));
        }
      } finally {
        setBusy(false);
      }
    },
    [onSelect, reload],
  );

  const pickFile = useCallback(async () => {
    setError(null);
    try {
      // Android 上系统文件选择器会把应用切到后台，按 SFTP 上传的同一套做法临时保活
      const picked = await withForegroundKeepAlive(keepAliveEnabled, () =>
        open({ multiple: false, title: '选择私钥文件' }),
      );
      if (!picked) return;
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      await runImport({ kind: 'file', path });
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }, [keepAliveEnabled, runImport]);

  const handleDelete = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        await tauri.deleteKey(id);
        setConfirmingDeleteId(null);
        if (selectedId === id) onSelect(undefined);
        await reload();
      } catch (e) {
        setError(getErrorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [onSelect, reload, selectedId],
  );

  const handleRename = useCallback(
    async (id: string) => {
      const name = renameValue.trim();
      if (!name) return;
      setBusy(true);
      setError(null);
      try {
        await tauri.renameKey(id, name);
        setRenamingId(null);
        await reload();
      } catch (e) {
        setError(getErrorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [reload, renameValue],
  );

  return (
    <div className="space-y-3 p-4">
      <p className="text-xs leading-relaxed text-zinc-500">
        导入的私钥会加密保存在本设备（应用自己的目录，磁盘上是密文），
        原文件之后挪走或删掉都不影响，多台连接也可以共用同一把。
      </p>

      {keys.length === 0 ? (
        <p className="rounded-lg border border-zinc-700/60 bg-zinc-900/40 px-3 py-4 text-center text-sm text-zinc-500">
          还没有导入任何私钥
        </p>
      ) : (
        <ul className="space-y-1.5">
          {keys.map((key) => {
            const selected = key.id === selectedId;
            const usage = usageOf?.(key.id) ?? 0;
            const confirming = confirmingDeleteId === key.id;
            const origin = origins[key.id];

            return (
              <li
                key={key.id}
                className={`border ${rowClass} ${
                  selected
                    ? 'border-indigo-500/70 bg-indigo-500/10'
                    : 'border-zinc-700 bg-zinc-900/40'
                }`}
              >
                {renamingId === key.id ? (
                  <div className="flex items-center gap-2">
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleRename(key.id);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      className={`min-w-0 flex-1 ${fieldClass}`}
                    />
                    <Button
                      variant="secondary"
                      className={smallBtnClass}
                      onClick={() => void handleRename(key.id)}
                    >
                      保存
                    </Button>
                    <Button
                      variant="ghost"
                      className={smallBtnClass}
                      onClick={() => setRenamingId(null)}
                    >
                      取消
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onSelect(selected ? undefined : key.id)}
                      className="min-w-0 flex-1 text-left"
                      aria-pressed={selected}
                    >
                      <div className="truncate text-sm text-zinc-100">
                        {key.name}
                        {key.encrypted && (
                          <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                            带密码
                          </span>
                        )}
                        {selected && (
                          <span className="ml-2 text-[10px] text-indigo-300">已选用</span>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-zinc-500">
                        {describeAlgorithm(key.algorithm)} · {shortFingerprint(key.fingerprint)}
                        {usage > 0 && ` · ${usage} 条连接在用`}
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setRenamingId(key.id);
                        setRenameValue(key.name);
                        setConfirmingDeleteId(null);
                      }}
                      className={`${rowActionClass} text-zinc-400 hover:text-zinc-200`}
                    >
                      重命名
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setConfirmingDeleteId(confirming ? null : key.id)
                      }
                      className={`${rowActionClass} text-red-400/80 hover:text-red-300`}
                    >
                      删除
                    </button>
                  </div>
                )}

                {origin?.changed && (
                  <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-amber-700/50 bg-amber-950/20 px-2.5 py-2">
                    <p className="text-xs leading-relaxed text-amber-200">
                      原文件已经是另一把钥匙了，库里这份还是旧的——如果你换过密钥，
                      连接会一直被服务器拒绝。
                    </p>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void runImport({ kind: 'refresh', id: key.id })}
                      className={`${rowActionClass} text-amber-200 hover:text-amber-100`}
                    >
                      用原文件更新
                    </button>
                  </div>
                )}

                {origin?.missing && (
                  <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                    原来的文件（
                    <span className="break-all">{origin.originPath}</span>
                    ）已不在，不影响使用。
                  </p>
                )}

                {confirming && (
                  <div className="mt-2 rounded-md border border-red-900/50 bg-red-950/30 px-2.5 py-2">
                    <p className="text-xs leading-relaxed text-red-200">
                      删除这把私钥？密文文件会一并删除。
                      {usage > 0
                        ? `有 ${usage} 条连接正在用它，它们之后需要重新选择一把。`
                        : '没有连接在用它。'}
                    </p>
                    <div className="mt-2 flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        className={smallBtnClass}
                        onClick={() => setConfirmingDeleteId(null)}
                      >
                        取消
                      </Button>
                      <Button
                        variant="secondary"
                        className={smallBtnClass}
                        disabled={busy}
                        onClick={() => void handleDelete(key.id)}
                      >
                        确认删除
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          className={inlineBtnClass}
          disabled={busy}
          onClick={() => void pickFile()}
        >
          {busy ? '正在读取…' : '选择密钥文件…'}
        </Button>
        <Button
          variant="secondary"
          className={inlineBtnClass}
          disabled={busy}
          onClick={() => {
            setPasteOpen((v) => !v);
            setPending(null);
            setPendingHint(null);
          }}
        >
          粘贴私钥内容…
        </Button>
      </div>

      {pending && (
        <div className="space-y-2 rounded-lg border border-amber-700/50 bg-amber-950/20 px-3 py-3">
          <p className="text-xs leading-relaxed text-amber-200">
            {pendingHint ?? '这把私钥带密码，请输入后继续。'}
          </p>
          <input
            autoFocus
            type="password"
            value={pendingPassphrase}
            onChange={(e) => setPendingPassphrase(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && pendingPassphrase) {
                void runImport(pending, pendingPassphrase);
              }
            }}
            placeholder="私钥密码"
            autoComplete="off"
            className={fieldClass}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              className={smallBtnClass}
              onClick={() => {
                setPending(null);
                setPendingHint(null);
                setPendingPassphrase('');
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              className={smallBtnClass}
              disabled={busy || !pendingPassphrase}
              onClick={() => void runImport(pending, pendingPassphrase)}
            >
              继续导入
            </Button>
          </div>
        </div>
      )}

      {pasteOpen && (
        <div className="space-y-2 rounded-lg border border-zinc-700 bg-zinc-900/40 px-3 py-3">
          <p className="text-xs leading-relaxed text-zinc-500">
            把私钥全文（-----BEGIN … 那一段，含首尾行）贴进来。
          </p>
          <input
            value={pasteName}
            onChange={(e) => setPasteName(e.target.value)}
            placeholder="给它起个名字（可留空）"
            className={fieldClass}
          />
          <textarea
            value={pasteContent}
            onChange={(e) => setPasteContent(e.target.value)}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            rows={touch ? 6 : 5}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className={`w-full resize-y rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-indigo-500 ${
              touch ? 'text-sm' : 'text-xs'
            }`}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              className={smallBtnClass}
              onClick={() => {
                setPasteOpen(false);
                setPending(null);
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              className={smallBtnClass}
              disabled={busy || !pasteContent.trim()}
              onClick={() =>
                void runImport({
                  kind: 'text',
                  content: pasteContent,
                  name: pasteName.trim(),
                })
              }
            >
              导入
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs leading-relaxed text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
