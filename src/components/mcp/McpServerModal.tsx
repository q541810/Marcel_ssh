import { useEffect, useState } from 'react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import type { McpServer, McpServerInput } from '@/lib/types';

type Step = 'choose' | 'json' | 'form';

interface Props {
  open: boolean;
  server?: McpServer | null;
  onClose: () => void;
  onSave: (input: McpServerInput) => Promise<void>;
}

interface ParsedMcpEntry {
  name: string;
  url: string;
  headers: Record<string, string>;
}

export function parseMcpJson(text: string): ParsedMcpEntry | null {
  try {
    const obj = JSON.parse(text);
    const servers = obj.mcpServers;
    if (!servers || typeof servers !== 'object') return null;
    const keys = Object.keys(servers);
    if (keys.length === 0) return null;
    const key = keys[0];
    const entry = servers[key];
    if (!entry || typeof entry.url !== 'string' || !entry.url.trim()) return null;
    const headers: Record<string, string> = {};
    if (entry.headers && typeof entry.headers === 'object') {
      for (const [k, v] of Object.entries(entry.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
    }
    return { name: key, url: entry.url.trim(), headers };
  } catch {
    return null;
  }
}

export function headersToText(h: Record<string, string>): string {
  return Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n');
}

export function textToHeaders(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    if (key) result[key] = match[2];
  }
  return result;
}

export default function McpServerModal({ open, server, onClose, onSave }: Props) {
  const [step, setStep] = useState<Step>(server ? 'form' : 'choose');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [trusted, setTrusted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (server) {
      setStep('form');
      setName(server.name);
      setUrl(server.url);
      setHeadersText(headersToText(server.headers ?? {}));
      setEnabled(server.enabled);
      setTrusted(server.trusted);
    } else {
      setStep('choose');
      setName('');
      setUrl('');
      setHeadersText('');
      setEnabled(true);
      setTrusted(false);
    }
    setError(null);
    setJsonText('');
    setJsonError(null);
  }, [open, server]);

  const handleImport = () => {
    const parsed = parseMcpJson(jsonText);
    if (!parsed) {
      setJsonError('无法解析 JSON，请确保包含 mcpServers 对象且第一个条目有 url 字段');
      return;
    }
    setName(parsed.name);
    setUrl(parsed.url);
    setHeadersText(headersToText(parsed.headers));
    setJsonError(null);
    setStep('form');
  };

  const handleSave = async () => {
    if (!name.trim()) { setError('名称不能为空'); return; }
    if (!url.trim()) { setError('URL 不能为空'); return; }
    setSaving(true);
    setError(null);
    const finalHeaders = textToHeaders(headersText);
    try {
      await onSave({ name: name.trim(), url: url.trim(), headers: finalHeaders, enabled, trusted });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const closeModal = () => {
    setStep(server ? 'form' : 'choose');
    onClose();
  };

  return (
    <Modal open={open} onClose={closeModal} title={server ? '编辑 MCP' : '新建 MCP'}>
      {/* ── Step: Choose ── */}
      {step === 'choose' && (
        <div className="p-6 space-y-4 text-center">
          <p className="text-sm text-zinc-400">选择添加方式</p>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setStep('json')}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border border-zinc-700 bg-zinc-900/60 hover:border-green-500 hover:bg-zinc-900 transition-colors"
            >
              <svg className="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h10m-6 6h12" />
              </svg>
              <span className="text-sm font-medium text-zinc-100">从 JSON 导入</span>
              <span className="text-xs text-zinc-500">粘贴标准 mcpServers 配置</span>
            </button>
            <button
              onClick={() => setStep('form')}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border border-zinc-700 bg-zinc-900/60 hover:border-green-500 hover:bg-zinc-900 transition-colors"
            >
              <svg className="w-6 h-6 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              <span className="text-sm font-medium text-zinc-100">手动填写</span>
              <span className="text-xs text-zinc-500">逐项输入名称和 URL</span>
            </button>
          </div>
        </div>
      )}

      {/* ── Step: JSON Import ── */}
      {step === 'json' && (
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">
              粘贴 <code className="text-xs bg-zinc-800 px-1 py-0.5 rounded">mcpServers</code> JSON
            </label>
            <textarea
              value={jsonText}
              onChange={(e) => { setJsonText(e.target.value); setJsonError(null); }}
              rows={8}
              placeholder={'{\n  "mcpServers": {\n    "my-server": {\n      "url": "https://...",\n      "headers": { "Authorization": "Bearer xxx" }\n    }\n  }\n}'}
              className="w-full rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-green-500 font-mono"
            />
            {jsonError && <p className="text-xs text-red-400 mt-1">{jsonError}</p>}
          </div>
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep('choose')}>返回</Button>
            <Button variant="primary" onClick={handleImport}>继续</Button>
          </div>
        </div>
      )}

      {/* ── Step: Form ── */}
      {step === 'form' && (
        <div className="p-4 space-y-4">
          <Input label="名称" value={name} onChange={(e) => setName(e.target.value)} placeholder="My MCP Server" />
          <Input label="URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.api-inference.modelscope.net/xxx/mcp" />
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">Headers</label>
            <textarea
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              rows={4}
              placeholder="Authorization: Bearer xxx\nX-Custom: value"
              className="w-full rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-green-500 font-mono"
            />
          </div>
          <label className="flex items-center justify-between rounded-lg bg-zinc-900/60 border border-zinc-700 px-3 py-2">
            <span>
              <span className="block text-sm text-zinc-200">启用</span>
              <span className="block text-xs text-zinc-500">启用后 Agent 会发现并注册该 MCP 的工具</span>
            </span>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          </label>
          <label className="flex items-center justify-between rounded-lg bg-zinc-900/60 border border-zinc-700 px-3 py-2">
            <span>
              <span className="block text-sm text-zinc-200">信任此 MCP</span>
              <span className="block text-xs text-zinc-500">信任后工具风险降低；默认不信任，需要审批</span>
            </span>
            <input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} />
          </label>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            {!server && <Button variant="ghost" onClick={() => setStep('choose')}>返回</Button>}
            {server && <Button variant="ghost" onClick={closeModal}>取消</Button>}
            <Button variant="primary" loading={saving} onClick={handleSave}>保存</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
