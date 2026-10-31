import { useEffect, useRef, useState } from 'react';
import { Check, Monitor, Smartphone } from 'lucide-react';
import Input from '@/components/ui/Input';
import { useSyncStore } from '@/stores/syncStore';
import { relativeTime } from '@/lib/memory';
import { getErrorMessage } from '@/lib/errors';
import type { SyncDevice } from '@/lib/types';
import { SyncButton, type SyncVariant } from './syncUi';

const PLATFORM_LABEL: Record<SyncDevice['platform'], string> = {
  desktop: '桌面',
  android: '手机',
};

/** 设备名最长多少字：只是个标签，太长在窄屏上也排不下。 */
const DEVICE_NAME_MAX = 40;

/**
 * 本设备名称：用户在别的设备的"设备列表"和"同步记录"里认出这台机器靠的就是它。
 * 改完点保存（或回车）；没改动时按钮不可点。
 */
export function DeviceNameEditor({ variant, name }: { variant: SyncVariant; name: string }) {
  const setDeviceName = useSyncStore((s) => s.setDeviceName);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();

  // 后端推来新名字（例如别处改了 / 刚保存完）就跟进；用户正在输入时不覆盖。
  const lastServerName = useRef(name);
  useEffect(() => {
    if (name !== lastServerName.current) {
      if (draft === lastServerName.current) setDraft(name);
      lastServerName.current = name;
    }
  }, [name, draft]);
  useEffect(() => () => clearTimeout(savedTimer.current), []);

  const trimmed = draft.trim();
  const changed = trimmed !== name && trimmed.length > 0;

  const save = async () => {
    if (!changed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await setDeviceName(trimmed);
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 1800);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Input
          aria-label="本设备名称"
          value={draft}
          maxLength={DEVICE_NAME_MAX}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void save();
            }
          }}
          className={variant === 'mobile' ? '!py-2.5' : ''}
        />
        <SyncButton variant={variant} kind="secondary" disabled={!changed} loading={saving} onClick={() => void save()}>
          {saved ? <Check className="h-4 w-4" aria-hidden /> : null}
          {saved ? '已保存' : '保存'}
        </SyncButton>
      </div>
      {error && (
        <p className="text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * 一台设备开了哪几档。用小圆点 + 名字，不用三种颜色：颜色在这里不承载额外信息，
 * 堆起来反而像状态告警。没开的档不显示——「只显示开着的那几档」比列一排灰字更好扫。
 */
function TierChips({ tiers }: { tiers: SyncDevice['tiers'] }) {
  const enabled = [
    tiers.config ? '配置' : null,
    tiers.conversation ? '对话' : null,
    tiers.secret ? '机密' : null,
  ].filter((label): label is string => label !== null);
  if (enabled.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1" aria-label={`开启了${enabled.join('、')}`}>
      {enabled.map((label) => (
        <span
          key={label}
          className="inline-flex items-center gap-1 rounded bg-state-mid px-1.5 py-0.5 text-[10px] leading-none text-zinc-400"
        >
          <span aria-hidden className="h-1 w-1 rounded-full bg-emerald-500" />
          {label}
        </span>
      ))}
    </span>
  );
}

/** 已加入同步的设备。新设备要等它第一次同步过之后才会出现——列表里没有不代表没加入成功。 */
export function DevicesList({ devices, loading, error }: { devices: SyncDevice[]; loading: boolean; error: string | null }) {
  if (error && devices.length === 0) {
    return (
      <p className="text-xs text-red-400" role="alert">
        读取设备列表失败：{error}
      </p>
    );
  }
  if (devices.length === 0) {
    return (
      <p className="text-xs text-zinc-500">
        {loading ? '正在读取设备列表…' : '暂时只有这台设备。其它设备加入后，要等它第一次同步完成才会出现在这里。'}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-edge-subtle">
      {devices.map((device) => {
        const Icon = device.platform === 'android' ? Smartphone : Monitor;
        return (
          <li key={device.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
            <Icon className="h-4 w-4 flex-shrink-0 text-zinc-500" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-200">
                <span className="truncate">{device.name}</span>
                {device.isSelf && (
                  <span className="flex-shrink-0 rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] text-indigo-300">
                    本机
                  </span>
                )}
                <TierChips tiers={device.tiers} />
              </div>
              <div className="text-xs text-zinc-500">
                {PLATFORM_LABEL[device.platform]} · v{device.appVersion}
                {device.isSelf ? '' : ` · 上次同步 ${relativeTime(device.lastSeenAt) || '时间未知'}`}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
