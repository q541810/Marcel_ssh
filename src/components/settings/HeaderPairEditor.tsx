import { useState } from 'react';
import Button from '@/components/ui/Button';
import { type HeaderPair, isReservedHeader } from '@/lib/channelHeaders';

interface Props {
  pairs: HeaderPair[];
  onChange: (pairs: HeaderPair[]) => void;
  disabled?: boolean;
}

/**
 * 自定义请求头编辑器（键值对列表）。
 *
 * 用于 OpenCode Go 这类需要客户端指纹头的服务（`user-agent`、`x-opencode-session`），
 * 以及自建网关的自定义鉴权。头最终存在系统密钥链里（不进 settings.json）。
 */
export default function HeaderPairEditor({ pairs, onChange, disabled }: Props) {
  const [show, setShow] = useState(false);
  const count = pairs.filter((p) => p.name.trim()).length;

  const update = (i: number, patch: Partial<HeaderPair>) =>
    onChange(pairs.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  const add = () => onChange([...pairs, { name: '', value: '' }]);

  const remove = (i: number) => onChange(pairs.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-body text-fg">自定义请求头</div>
          <div className="text-caption text-fg-tertiary">
            {count > 0 ? `已配置 ${count} 条` : '按需添加，多数渠道不需要'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="px-3 py-2 rounded-lg text-meta text-fg-secondary bg-surface-raised hover:bg-state-mid transition-colors"
        >
          {show ? '收起' : count > 0 ? `编辑（${count}）` : '添加'}
        </button>
      </div>

      {show && (
        <div className="space-y-2 rounded-lg border border-edge-subtle bg-surface/40 p-3">
          <p className="text-caption leading-relaxed text-fg-tertiary">
            加密保存在系统密钥链，不写进配置文件。常用于需要客户端指纹头的服务，
            例如 <code className="text-fg-secondary">user-agent</code>、
            <code className="text-fg-secondary">x-opencode-session</code>。
          </p>

          {pairs.length === 0 && (
            <p className="py-2 text-center text-meta text-fg-disabled">还没有自定义请求头</p>
          )}

          {pairs.map((p, i) => {
            const reserved = isReservedHeader(p.name);
            return (
              <div key={i} className="space-y-1">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={p.name}
                    disabled={disabled}
                    onChange={(e) => update(i, { name: e.target.value })}
                    placeholder="头名，如 user-agent"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className={`w-2/5 rounded-lg bg-surface border px-3 py-2 text-meta font-mono text-fg placeholder:text-fg-disabled focus:outline-none focus:border-indigo-500 ${
                      reserved ? 'border-amber-600/60' : 'border-edge'
                    }`}
                  />
                  <input
                    type="text"
                    value={p.value}
                    disabled={disabled}
                    onChange={(e) => update(i, { value: e.target.value })}
                    placeholder="值"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className="flex-1 rounded-lg bg-surface border border-edge px-3 py-2 text-meta font-mono text-fg placeholder:text-fg-disabled focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={() => remove(i)}
                    disabled={disabled}
                    className="flex-shrink-0 rounded px-2 py-1 text-meta text-fg-tertiary hover:bg-state-soft hover:text-red-400 transition-colors"
                    aria-label="删除这条请求头"
                  >
                    删除
                  </button>
                </div>
                {reserved && (
                  <p className="text-caption text-amber-400/90">
                    这个头由程序管理，填写后不会生效
                  </p>
                )}
              </div>
            );
          })}

          <Button variant="secondary" size="sm" onClick={add} disabled={disabled}>
            + 添加一条
          </Button>
        </div>
      )}
    </div>
  );
}
