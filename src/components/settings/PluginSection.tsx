import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Puzzle, Eye, Wrench, Shield, FolderOpen, Check, Settings } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { getPluginDir, openPluginDir } from '@/lib/tauri';
import { usePluginStore } from '@/stores/pluginStore';
import type { PluginManifest } from '@/lib/types';
import Toggle from '@/components/ui/Toggle';
import Button from '@/components/ui/Button';
import { useSettingsActions } from './SettingsActionsContext';
import { Card, SettingItem } from './helpers';
import PluginConfigModal from './PluginConfigModal';

const CAPABILITY_LABELS: Record<string, string> = {
  'ssh.list': '查询 SSH 会话与连接信息',
  'ssh.exec': '执行远程命令',
  'sftp.read': '读取远程文件',
  'sftp.write': '写入远程文件',
  'fs.read': '读取本地文件',
  'fs.write': '写入本地文件',
  'net.request': '发起网络请求',
  'notification': '发送通知',
};

const MOUNT_LABELS: Record<string, string> = {
  sidebar: '左侧面板',
  center: '中央面板',
  bottom: '底部面板',
  agent: '右侧面板',
};

function CapabilityManager({ pluginId, declared }: { pluginId: string; declared: string[] }) {
  const { settings, update } = useSettingsActions();
  const authorizedMap = settings.authorizedCapabilities ?? {};
  const authorizedList = authorizedMap[pluginId];

  const isAuthorized = (cap: string) => {
    if (!authorizedList) return declared.includes(cap);
    return authorizedList.includes(cap);
  };

  const toggleCapability = (cap: string) => {
    const current = authorizedList ?? [...declared];
    const next = current.includes(cap)
      ? current.filter((c) => c !== cap)
      : [...current, cap];

    const allAuthorized = declared.every((c) => next.includes(c)) && next.length >= declared.length;
    const newMap = { ...authorizedMap };
    if (allAuthorized) {
      delete newMap[pluginId];
    } else {
      newMap[pluginId] = next;
    }
    update({ authorizedCapabilities: newMap });
  };

  return (
    <div className="space-y-2">
      {declared.map((cap) => (
        <div key={cap} className="flex items-center justify-between py-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm text-zinc-300">
              {CAPABILITY_LABELS[cap] ?? cap}
            </span>
            {CAPABILITY_LABELS[cap] && (
              <code className="text-[11px] text-zinc-600 bg-zinc-800 px-1.5 py-0.5 rounded flex-shrink-0">{cap}</code>
            )}
          </div>
          <Toggle
            checked={isAuthorized(cap)}
            onChange={() => toggleCapability(cap)}
            size="sm"
          />
        </div>
      ))}
    </div>
  );
}

function PluginCard({ manifest }: { manifest: PluginManifest }) {
  const { settings, update } = useSettingsActions();
  const disabledSet = new Set(settings.disabledPlugins ?? []);
  const isDisabled = disabledSet.has(manifest.id);
  const [showCapabilities, setShowCapabilities] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);

  const togglePlugin = () => {
    const current = settings.disabledPlugins ?? [];
    const next = isDisabled
      ? current.filter((id) => id !== manifest.id)
      : [...current, manifest.id];
    update({ disabledPlugins: next });
  };

  const viewCount = manifest.views.length;
  const toolCount = manifest.agentTools.length;
  const capCount = manifest.capabilities.length;
  const hasConfigView = !!manifest.configView;

  return (
    <>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-3 min-w-0">
            <Puzzle className="w-5 h-5 text-zinc-500 flex-shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-zinc-100 truncate">{manifest.name}</span>
                <span className="text-[11px] text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded flex-shrink-0">v{manifest.version}</span>
              </div>
              {manifest.publisher && (
                <div className="text-xs text-zinc-500 mt-0.5">{manifest.publisher}</div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={!hasConfigView}
              onClick={() => hasConfigView && setConfigOpen(true)}
              title={hasConfigView ? '打开配置界面' : '此插件未提供配置界面'}
            >
              <Settings className="w-3.5 h-3.5" />
              配置
            </Button>
            <Toggle
              checked={!isDisabled}
              onChange={togglePlugin}
            />
          </div>
        </div>

      {/* Description */}
      {manifest.description && (
        <div className="px-5 py-3 border-b border-zinc-800">
          <p className="text-sm text-zinc-400 leading-relaxed">{manifest.description}</p>
        </div>
      )}

      {/* Capabilities summary */}
      <div className="px-5 py-3 space-y-3">
        <div className="flex items-center gap-4 text-xs text-zinc-500">
          {viewCount > 0 && (
            <div className="flex items-center gap-1.5">
              <Eye className="w-3.5 h-3.5" />
              <span>{viewCount} 个视图</span>
            </div>
          )}
          {toolCount > 0 && (
            <div className="flex items-center gap-1.5">
              <Wrench className="w-3.5 h-3.5" />
              <span>{toolCount} 个工具</span>
            </div>
          )}
          {capCount > 0 && (
            <div className="flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5" />
              <span>{capCount} 个权限</span>
            </div>
          )}
        </div>

        {/* Views detail */}
        {viewCount > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {manifest.views.map((v) => (
              <span
                key={v.id}
                className="inline-flex items-center gap-1 text-[11px] text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded-full"
              >
                {MOUNT_LABELS[v.mount] ?? v.mount}：{v.title}
              </span>
            ))}
          </div>
        )}

        {/* Agent tools detail */}
        {toolCount > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {manifest.agentTools.map((t) => (
              <span
                key={t.name}
                className="inline-flex items-center gap-1 text-[11px] text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded-full"
              >
                <Wrench className="w-3 h-3" />
                {t.name}
              </span>
            ))}
          </div>
        )}

        {/* Capability management */}
        {capCount > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowCapabilities(!showCapabilities)}
              className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              {showCapabilities
                ? <ChevronDown className="w-3.5 h-3.5" />
                : <ChevronRight className="w-3.5 h-3.5" />}
              管理权限
            </button>
            {showCapabilities && (
              <div className="mt-2 pl-1">
                <CapabilityManager pluginId={manifest.id} declared={manifest.capabilities} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>

    {hasConfigView && (
      <PluginConfigModal
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        pluginId={manifest.id}
        pluginName={manifest.name}
        configView={manifest.configView!}
      />
    )}
    </>
  );
}

export function PluginSection() {
  const manifests = usePluginStore((s) => s.manifests);
  const loading = usePluginStore((s) => s.loading);
  const error = usePluginStore((s) => s.error);
  const fetchPlugins = usePluginStore((s) => s.fetchPlugins);
  const [pluginDir, setPluginDir] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getPluginDir().then(setPluginDir);
  }, []);

  const handleCopy = async () => {
    await writeText(pluginDir);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-6">
      {/* Plugin directory + refresh */}
      <Card id="settings-plugins" title="插件" description="管理本地安装的插件">
        <SettingItem
          id="plugins-directory"
          label="插件目录"
          description="将插件放入此目录后点击刷新即可发现"
          sectionId="settings-plugins"
          keywords={['plugin', 'directory', 'path', '插件', '目录']}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="text-xs text-zinc-500 font-mono cursor-pointer hover:text-zinc-300 transition-colors select-all"
              title="点击复制路径"
              onClick={handleCopy}
            >
              {copied ? (
                <span className="inline-flex items-center gap-1 text-emerald-400">
                  <Check className="w-3 h-3" />
                  已复制
                </span>
              ) : (
                pluginDir
              )}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openPluginDir()}
              title="打开目录"
            >
              <FolderOpen className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={loading}
              onClick={() => fetchPlugins()}
            >
              刷新
            </Button>
          </div>
        </SettingItem>
      </Card>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-5 py-4 text-sm text-red-400">
          加载失败：{error}
        </div>
      )}

      {/* Plugin cards */}
      {!loading && !error && manifests.length === 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-6 py-12 text-center">
          <Puzzle className="w-8 h-8 text-zinc-700 mx-auto mb-3" />
          <p className="text-sm text-zinc-500">暂无已安装插件</p>
          <p className="text-xs text-zinc-600 mt-1">将插件放入上方目录后点击刷新</p>
        </div>
      )}

      {!loading && !error && manifests.map((m) => (
        <PluginCard key={m.id} manifest={m} />
      ))}

    </div>
  );
}
