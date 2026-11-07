import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

import Button from '@/components/ui/Button';

// MCP 服务设置页（桌面 McpServerSection / 手机 MobileMcpServerSection）共用的小部件。
// 「复制 → 已复制」反馈、配置片段的展示方式必须两端一致，所以只留这一份。

/**
 * 复制按钮：按下即反馈。
 *
 * 用局部组件而不是每处重写，是因为「复制 → 短暂显示已复制」这个反馈
 * 必须处处一致——不一致的反馈比没有反馈更让人怀疑到底成没成。
 */
export function CopyButton({
  text,
  label = '复制',
  size = 'sm',
}: {
  text: string;
  label?: string;
  /** 手机端传 md，触控目标够大 */
  size?: 'sm' | 'md';
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 复制失败保持原样：不谎报成功
    }
  };

  return (
    <Button variant="secondary" size={size} onClick={handleCopy} className="shrink-0">
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? '已复制' : label}
    </Button>
  );
}

/**
 * 配置片段展示。
 *
 * monospace + 横向滚动：路径在 Windows 上很长，换行会让 JSON 看起来是坏的。
 * 复制按钮贴在代码块右上角，紧邻它复制的东西（控件靠近它影响的对象）。
 */
export function CodeBlock({ code, touch = false }: { code: string; touch?: boolean }) {
  return (
    <div className="relative rounded-lg bg-surface-sunken border border-edge-subtle">
      <div className="absolute top-2 right-2">
        <CopyButton text={code} size={touch ? 'md' : 'sm'} />
      </div>
      <pre className="overflow-x-auto p-3 pr-24 text-caption leading-5 font-mono text-fg-secondary">
        {code}
      </pre>
    </div>
  );
}

/** 运行状态指示：一眼看出服务在不在跑。 */
export function StatusPill({ running }: { running: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 text-meta">
      <span
        className={`w-1.5 h-1.5 rounded-full ${running ? 'bg-emerald-400' : 'bg-zinc-600'}`}
        aria-hidden
      />
      <span className={running ? 'text-emerald-400' : 'text-fg-tertiary'}>
        {running ? '运行中' : '已停止'}
      </span>
    </span>
  );
}
