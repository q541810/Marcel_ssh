import { useState, useRef } from 'react';
import { Trash2 } from 'lucide-react';
import { Card, SettingItem } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';
import { validateCustomProtectedPaths } from '@/lib/tauri';

const BUILT_IN_PROTECTED: ReadonlyArray<{ path: string; reason: string }> = [
  { path: '/etc', reason: '系统配置' },
  { path: '/boot', reason: '启动分区' },
  { path: '/sys', reason: 'sysfs 设备' },
  { path: '/proc', reason: '进程信息' },
  { path: '/dev', reason: '设备文件' },
];

/** Pre-flight check before calling the backend. Returns an error message
 * or null if the input is a candidate worth validating remotely. */
export function preCheckCustomPath(
  trimmed: string,
  existingPaths: string[],
): string | null {
  if (!trimmed) return null;
  if (existingPaths.includes(trimmed)) {
    return `路径已存在：${trimmed}`;
  }
  return null;
}

export default function CustomProtectedPathsSection() {
  const { settings, update } = useSettingsActions();
  const customPaths = settings.customProtectedPaths ?? [];

  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Validation is only triggered on submit, never on every keystroke.
  // Users can type freely without being interrupted.
  const submitAdd = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    const localErr = preCheckCustomPath(trimmed, customPaths);
    if (localErr) {
      setError(localErr);
      return;
    }
    const err = await validateCustomProtectedPaths([trimmed]);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setDraft('');
    update({ customProtectedPaths: [...customPaths, trimmed] });
    inputRef.current?.focus();
  };

  // Clear error the moment user starts editing again
  const handleChange = (v: string) => {
    if (error) setError(null);
    setDraft(v);
  };

  const handleRemove = (path: string) => {
    update({ customProtectedPaths: customPaths.filter((p) => p !== path) });
  };

  return (
    <Card
      id="settings-custom-protected-paths"
      title="受保护路径"
      description="Agent 在这些路径下的写操作会触发用户审批。内置 /etc、/boot 等已默认保护。"
    >
      <SettingItem
        id="custom-protected-list"
        label="当前内置保护路径"
        sectionId="settings-custom-protected-paths"
        keywords={['protected', 'paths', '受保护', '路径', 'agent', '审批']}
        density="compact"
      >
        <ul className="text-xs text-zinc-400 space-y-0.5">
          {BUILT_IN_PROTECTED.map((p) => (
            <li key={p.path}>
              <code className="text-indigo-300">{p.path}</code>
              <span className="text-zinc-500"> — {p.reason}（内置，无法删除）</span>
            </li>
          ))}
        </ul>
      </SettingItem>

      <SettingItem
        id="custom-protected-add"
        label="添加自定义受保护路径"
        sectionId="settings-custom-protected-paths"
        keywords={['add', 'custom', 'protected', '添加', '自定义', '受保护', 'agent', '审批']}
        density="compact"
      >
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => handleChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submitAdd();
                }
              }}
              placeholder="/home/user/.ssh"
              className="flex-1 rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-100 placeholder-zinc-600 outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button
              type="button"
              onClick={() => void submitAdd()}
              className="rounded-md bg-indigo-600 px-3 py-1 text-xs text-white hover:bg-indigo-500 transition-colors"
            >
              添加
            </button>
          </div>
          {error && (
            <p className="text-xs text-red-400" role="alert">
              {error}
            </p>
          )}
        </div>
      </SettingItem>

      {customPaths.length > 0 && (
        <SettingItem
          id="custom-protected-custom"
          label="自定义受保护路径"
          sectionId="settings-custom-protected-paths"
          keywords={['custom', 'list', '自定义', '受保护', 'agent']}
          density="compact"
        >
          <ul className="text-xs space-y-1">
            {customPaths.map((p) => (
              <li
                key={p}
                className="flex items-center justify-between gap-2 rounded-md bg-zinc-800 px-2 py-1"
              >
                <code className="text-indigo-300 truncate">{p}</code>
                <button
                  type="button"
                  onClick={() => handleRemove(p)}
                  className="text-zinc-500 hover:text-red-400 transition-colors flex-shrink-0"
                  title={`移除 ${p}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </SettingItem>
      )}
    </Card>
  );
}
