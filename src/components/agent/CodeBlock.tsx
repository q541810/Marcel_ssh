import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { copyText } from '@/lib/copyText';
import { codeLanguage, codeToCopy, type HastNode } from '@/lib/hastText';

type CopyState = 'idle' | 'copied' | 'failed';

const RESET_MS = { copied: 1300, failed: 2500 } as const;

/**
 * 代码块 = 顶栏（语言名 + 复制按钮）+ 代码。手机上长按选中代码很容易连旁边的正文一起选上，
 * 所以给一个一键复制整块的入口。按钮在顶栏里而不是浮在代码上，不会盖住第一行，桌面手机都常显
 * （样式见 globals.css 的 marcel-code-*）。
 */
export default function CodeBlock({
  node,
  children,
  ...preProps
}: ComponentPropsWithoutRef<'pre'> & { node?: HastNode }) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<number | null>(null);
  // 流式输出时代码还在长：点击那一刻再取文本，而不是渲染时算好。
  const nodeRef = useRef(node);
  nodeRef.current = node;

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const handleCopy = async () => {
    let next: CopyState = 'copied';
    try {
      await copyText(codeToCopy(nodeRef.current));
    } catch {
      next = 'failed';
    }
    setState(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), RESET_MS[next]);
  };

  const label = state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : '复制';
  // 没标语言也给左侧一个名字，顶栏两端才平衡；与围栏常见的缺省叫法一致。
  const language = codeLanguage(node) ?? 'text';

  return (
    <div className="marcel-code-block">
      <div className="marcel-code-bar">
        <span>{language}</span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={state === 'idle' ? '复制代码' : label}
          data-state={state}
          className="marcel-code-copy"
        >
          {state === 'copied' ? (
            <Check className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
          ) : (
            <Copy className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
          )}
          <span>{label}</span>
        </button>
      </div>
      <pre {...preProps}>{children}</pre>
    </div>
  );
}
