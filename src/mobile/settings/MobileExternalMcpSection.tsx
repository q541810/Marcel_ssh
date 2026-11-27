import { useEffect, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import Toggle from '@/components/ui/Toggle';
import { getErrorMessage } from '@/lib/errors';
import { headersToText, parseMcpJson, textToHeaders } from '@/lib/mcpClientForm';
import type { McpServer, McpServerInput } from '@/lib/types';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMcpStore } from '@/stores/mcpStore';
import MobileSheet from '../ui/MobileSheet';
import { MobileSettingRow } from './MobileSettingRow';

type AddStep = 'choose' | 'json' | 'form';

interface FormState {
  id?: string;
  name: string;
  url: string;
  headersText: string;
  enabled: boolean;
  trusted: boolean;
  step: AddStep;
}

const EMPTY_FORM: FormState = {
  name: '',
  url: '',
  headersText: '',
  enabled: true,
  trusted: false,
  step: 'choose',
};

const inputClass = 'w-full rounded-lg field px-3 py-2.5 text-body text-fg';

function formForServer(server: McpServer): FormState {
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    headersText: headersToText(server.headers ?? {}),
    enabled: server.enabled,
    trusted: server.trusted,
    step: 'form',
  };
}

/** Marcel 作为 client 连接外部 HTTP MCP；与下方对外提供工具的 MCP 服务方向相反。 */
export function MobileExternalMcpSection() {
  const servers = useMcpStore((s) => s.servers);
  const statuses = useMcpStore((s) => s.statuses);
  const loading = useMcpStore((s) => s.loading);
  const refreshingIds = useMcpStore((s) => s.refreshingIds);
  const storeError = useMcpStore((s) => s.error);
  const fetchServers = useMcpStore((s) => s.fetchServers);
  const addServer = useMcpStore((s) => s.addServer);
  const updateServer = useMcpStore((s) => s.updateServer);
  const deleteServer = useMcpStore((s) => s.deleteServer);
  const toggleServer = useMcpStore((s) => s.toggleServer);
  const refreshTools = useMcpStore((s) => s.refreshTools);
  const confirmEachCommand = useSettingsStore(
    (s) => s.settings.agentModeSettings.confirmEachCommand,
  );

  const [form, setForm] = useState<FormState | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<McpServer | null>(null);
  const [jsonText, setJsonText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    void fetchServers();
  }, [fetchServers]);

  const openForm = (next: FormState) => {
    setFormError(null);
    setForm(next);
  };

  const closeForm = () => {
    if (saving) return;
    setForm(null);
    setFormError(null);
  };

  const importJson = () => {
    const parsed = parseMcpJson(jsonText);
    if (!parsed) {
      setFormError('无法解析 JSON，请确保包含 mcpServers 对象且第一个条目有 url 字段');
      return;
    }
    setFormError(null);
    openForm({
      ...EMPTY_FORM,
      name: parsed.name,
      url: parsed.url,
      headersText: headersToText(parsed.headers),
      step: 'form',
    });
  };

  const save = async () => {
    if (!form) return;
    if (!form.name.trim()) {
      setFormError('名称不能为空');
      return;
    }
    if (!form.url.trim()) {
      setFormError('URL 不能为空');
      return;
    }
    const input: McpServerInput = {
      name: form.name.trim(),
      url: form.url.trim(),
      headers: textToHeaders(form.headersText),
      enabled: form.enabled,
      trusted: form.trusted,
    };
    setSaving(true);
    setFormError(null);
    try {
      if (form.id) await updateServer(form.id, input);
      else await addServer(input);
      setForm(null);
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const id = deleteTarget.id;
    try {
      await deleteServer(id);
      setDeleteTarget(null);
      setExpandedId((current) => (current === id ? null : current));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => {
          setJsonText('');
          openForm({ ...EMPTY_FORM });
        }}
        className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-dashed border-edge bg-surface/50 px-3 py-3 text-body text-fg-secondary pressable active:bg-state-soft"
      >
        <Plus className="h-4 w-4" />
        添加 MCP
      </button>

      {storeError && (
        <div role="alert" className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-meta text-red-300">
          {storeError}
        </div>
      )}

      {loading && servers.length === 0 && (
        <p className="py-6 text-center text-body text-fg-tertiary">正在加载 MCP…</p>
      )}
      {!loading && servers.length === 0 && !storeError && (
        <p className="px-3 py-5 text-center text-meta leading-relaxed text-fg-tertiary">
          还没有外部 MCP。添加后，Agent 就能使用这些服务器提供的工具。
        </p>
      )}

      {servers.map((server) => {
        const status = statuses[server.id];
        const tools = status?.tools ?? [];
        const discovered = status?.discovered === true;
        const refreshing = !!refreshingIds[server.id];
        const expanded = expandedId === server.id;
        return (
          <div key={server.id} className="rounded-xl bg-surface-raised px-4 py-3">
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpandedId(expanded ? null : server.id)}
                className="min-w-0 flex-1 py-0.5 text-left pressable"
              >
                <span className={`block truncate text-body font-medium ${server.enabled ? 'text-fg' : 'text-fg-secondary'}`}>
                  {server.name}
                </span>
                <span className="mt-0.5 block truncate text-meta text-fg-tertiary">{server.url}</span>
              </button>
              <button
                type="button"
                aria-label={`刷新 ${server.name} 的工具`}
                title="刷新工具"
                disabled={refreshing}
                onClick={() => void refreshTools(server.id)}
                className="hit-area flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-fg-tertiary pressable active:bg-state-soft disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              </button>
              <Toggle
                checked={server.enabled}
                onChange={() => void toggleServer(server.id)}
                ariaLabel={server.enabled ? `停用 ${server.name}` : `启用 ${server.name}`}
              />
            </div>
            <div className="mt-1.5 text-meta text-fg-tertiary">
              {refreshing
                ? '正在连接并发现工具…'
                : status?.error
                  ? <span className="break-words text-red-300">{status.error}</span>
                  : discovered
                    ? tools.length > 0
                      ? `已发现 ${tools.length} 个工具 · ${server.trusted ? '已信任' : '默认需审批'}`
                      : '连接成功，未发现工具'
                    : '尚未发现工具，点右侧刷新'}
            </div>
            {expanded && (
              <div className="mt-3 space-y-3 border-t border-edge-subtle pt-3">
                {tools.length > 0 && (
                  <div className="space-y-2">
                    {tools.map((tool) => (
                      <div key={tool.name}>
                        <div className="break-words font-mono text-meta text-fg-secondary">{tool.name}</div>
                        {tool.description && (
                          <div className="mt-0.5 text-meta leading-relaxed text-fg-tertiary">{tool.description}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {!discovered && !refreshing && !status?.error && (
                  <p className="text-meta text-fg-tertiary">刷新后会在这里列出 Agent 可以使用的工具。</p>
                )}
                {server.trusted && confirmEachCommand && (
                  <p className="text-meta leading-relaxed text-amber-300">
                    当前是「每条都确认」，信任后仍需手动审批。
                  </p>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => openForm(formForServer(server))}
                    className="flex-1 rounded-lg bg-fill px-3 py-2.5 text-body text-fg-secondary pressable active:bg-state-mid"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(server)}
                    className="flex-1 rounded-lg bg-fill px-3 py-2.5 text-body text-red-300 pressable active:bg-state-mid"
                  >
                    删除
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <MobileSheet
        open={form !== null}
        onClose={closeForm}
        dismissible={!saving}
        title={form?.id ? '编辑 MCP' : form?.step === 'form' ? '添加 MCP' : '添加外部 MCP'}
        footer={
          form?.step === 'choose' ? undefined : (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  if (form && !form.id) {
                    setFormError(null);
                    setForm({ ...form, step: 'choose' });
                  } else {
                    closeForm();
                  }
                }}
                disabled={saving}
                className="flex-1 rounded-xl bg-fill px-4 py-3 text-body text-fg-secondary pressable active:bg-state-mid disabled:opacity-40"
              >
                {form && !form.id ? '返回' : '取消'}
              </button>
              <button
                type="button"
                onClick={() => void (form?.step === 'json' ? importJson() : save())}
                disabled={saving}
                className="flex-1 rounded-xl bg-indigo-600 px-4 py-3 text-body font-medium text-white pressable active:bg-indigo-500 disabled:opacity-40"
              >
                {form?.step === 'json' ? '继续' : saving ? '保存中…' : '保存'}
              </button>
            </div>
          )
        }
      >
        {form && (
          <div className="space-y-3 px-4 pb-4">
            {formError && (
              <div role="alert" className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-meta text-red-300">
                {formError}
              </div>
            )}
            {form.step === 'choose' && (
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, step: 'json' })}
                  className="min-h-20 rounded-xl bg-fill px-3 py-4 text-body text-fg-secondary pressable active:bg-state-mid"
                >
                  粘贴 JSON
                  <span className="mt-1 block text-meta text-fg-tertiary">从标准配置导入</span>
                </button>
                <button
                  type="button"
                  onClick={() => setForm({ ...form, step: 'form' })}
                  className="min-h-20 rounded-xl bg-fill px-3 py-4 text-body text-fg-secondary pressable active:bg-state-mid"
                >
                  手动填写
                  <span className="mt-1 block text-meta text-fg-tertiary">输入地址与鉴权</span>
                </button>
              </div>
            )}
            {form.step === 'json' && (
              <div>
                <label htmlFor="mobile-mcp-json" className="mb-1 block text-meta text-fg-secondary">
                  mcpServers 配置
                </label>
                <textarea
                  id="mobile-mcp-json"
                  value={jsonText}
                  onChange={(e) => {
                    setJsonText(e.target.value);
                    setFormError(null);
                  }}
                  rows={9}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={'{\n  "mcpServers": {\n    "my-server": {\n      "url": "https://...",\n      "headers": { "Authorization": "Bearer xxx" }\n    }\n  }\n}'}
                  className={`${inputClass} resize-y font-mono text-meta leading-relaxed`}
                />
                <p className="mt-2 text-meta leading-relaxed text-fg-tertiary">
                  与桌面一样，导入第一个带 url 的服务器条目。
                </p>
              </div>
            )}
            {form.step === 'form' && (
              <>
                <div>
                  <label htmlFor="mobile-mcp-name" className="mb-1 block text-meta text-fg-secondary">名称</label>
                  <input
                    id="mobile-mcp-name"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="My MCP Server"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="mobile-mcp-url" className="mb-1 block text-meta text-fg-secondary">服务器 URL</label>
                  <input
                    id="mobile-mcp-url"
                    type="url"
                    inputMode="url"
                    value={form.url}
                    onChange={(e) => setForm({ ...form, url: e.target.value })}
                    placeholder="https://example.com/mcp"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className={inputClass}
                  />
                  <p className="mt-1.5 text-meta leading-relaxed text-fg-tertiary">
                    使用 HTTP 连接；请只添加你信任的服务器。
                  </p>
                </div>
                <div>
                  <label htmlFor="mobile-mcp-headers" className="mb-1 block text-meta text-fg-secondary">
                    Headers（可选）
                  </label>
                  <textarea
                    id="mobile-mcp-headers"
                    value={form.headersText}
                    onChange={(e) => setForm({ ...form, headersText: e.target.value })}
                    rows={3}
                    placeholder="Authorization: Bearer xxx"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className={`${inputClass} resize-y font-mono text-meta`}
                  />
                  <p className="mt-1.5 text-meta leading-relaxed text-fg-tertiary">
                    每行一个「名称: 值」，按现有机制保存到本机密钥存储。
                  </p>
                </div>
                <MobileSettingRow
                  label="启用"
                  description="启用后 Agent 才能发现并使用这里的工具"
                  trailing={
                    <Toggle
                      checked={form.enabled}
                      onChange={(enabled) => setForm({ ...form, enabled })}
                      ariaLabel="启用 MCP"
                    />
                  }
                />
                <MobileSettingRow
                  label="信任此 MCP"
                  description="默认每次使用工具都需要审批；信任后服从全局审批设置"
                  trailing={
                    <Toggle
                      checked={form.trusted}
                      onChange={(trusted) => setForm({ ...form, trusted })}
                      ariaLabel="信任此 MCP"
                    />
                  }
                />
              </>
            )}
          </div>
        )}
      </MobileSheet>

      <MobileSheet
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        dismissible={!deleting}
        title="删除外部 MCP"
        footer={
          <div className="flex gap-2">
            <button
              type="button"
              disabled={deleting}
              onClick={() => setDeleteTarget(null)}
              className="flex-1 rounded-xl bg-fill px-4 py-3 text-body text-fg-secondary pressable active:bg-state-mid disabled:opacity-40"
            >
              取消
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={() => void confirmDelete()}
              className="flex-1 rounded-xl bg-red-600 px-4 py-3 text-body font-medium text-white pressable active:bg-red-500 disabled:opacity-40"
            >
              {deleting ? '删除中…' : '删除'}
            </button>
          </div>
        }
      >
        <p className="px-4 pb-4 text-body leading-relaxed text-fg-secondary">
          删除「{deleteTarget?.name}」？Agent 将不再获得它提供的工具，已保存的鉴权信息也会移除。
        </p>
      </MobileSheet>
    </div>
  );
}
