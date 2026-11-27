import { useEffect, useState } from 'react';
import { AlignLeft, PenLine } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { getErrorMessage } from '@/lib/errors';
import { headersToText, parseMcpJson, textToHeaders } from '@/lib/mcpClientForm';
import type { McpServer, McpServerInput } from '@/lib/types';

type Step = 'choose' | 'json' | 'form';

interface Props {
  open: boolean;
  server?: McpServer | null;
  onClose: () => void;
  onSave: (input: McpServerInput) => Promise<void>;
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
      // onSave 来自 mcpStore（addServer/updateServer）：它落完 store 错误后原样
      // rethrow 结构化 AppError 对象。原来这里是 `err instanceof Error ? … : String(err)`，
      // 于是 UI 上会出现 "[object Object]"。
      setError(getErrorMessage(err));
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
          <p className="text-body text-fg-secondary">选择添加方式</p>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setStep('json')}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border border-edge bg-surface/60 hover:border-indigo-500 hover:bg-surface transition-colors"
            >
              <AlignLeft size={24} strokeWidth={1.5} className="text-indigo-400" />
              <span className="text-body font-medium text-fg">从 JSON 导入</span>
              <span className="text-meta text-fg-tertiary">粘贴标准 mcpServers 配置</span>
            </button>
            <button
              onClick={() => setStep('form')}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border border-edge bg-surface/60 hover:border-indigo-500 hover:bg-surface transition-colors"
            >
              <PenLine size={24} strokeWidth={1.5} className="text-fg-secondary" />
              <span className="text-body font-medium text-fg">手动填写</span>
              <span className="text-meta text-fg-tertiary">逐项输入名称和 URL</span>
            </button>
          </div>
        </div>
      )}

      {/* ── Step: JSON Import ── */}
      {step === 'json' && (
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-body font-medium text-fg-secondary mb-1">
              粘贴 <code className="text-meta bg-surface-raised px-1 py-0.5 rounded">mcpServers</code> JSON
            </label>
            <textarea
              value={jsonText}
              onChange={(e) => { setJsonText(e.target.value); setJsonError(null); }}
              rows={8}
              placeholder={'{\n  "mcpServers": {\n    "my-server": {\n      "url": "https://...",\n      "headers": { "Authorization": "Bearer xxx" }\n    }\n  }\n}'}
              className="w-full rounded-lg field px-3 py-2 text-meta text-fg font-mono"
            />
            {jsonError && <p className="text-meta text-red-400 mt-1">{jsonError}</p>}
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
            <label className="block text-body font-medium text-fg-secondary mb-1">Headers</label>
            <textarea
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              rows={4}
              placeholder="Authorization: Bearer xxx\nX-Custom: value"
              className="w-full rounded-lg field px-3 py-2 text-meta text-fg font-mono"
            />
          </div>
          <label className="flex items-center justify-between rounded-lg bg-surface/60 border border-edge px-3 py-2">
            <span>
              <span className="block text-body text-fg">启用</span>
              <span className="block text-meta text-fg-tertiary">启用后 Agent 会发现并注册该 MCP 的工具</span>
            </span>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          </label>
          <label className="flex items-center justify-between rounded-lg bg-surface/60 border border-edge px-3 py-2">
            <span>
              <span className="block text-body text-fg">信任此 MCP</span>
              <span className="block text-meta text-fg-tertiary">信任后工具风险降低；默认不信任，需要审批</span>
            </span>
            <input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} />
          </label>
          {error && <p className="text-body text-red-400">{error}</p>}
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
