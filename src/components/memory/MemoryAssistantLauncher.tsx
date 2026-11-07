import { useState } from 'react';
import { Loader2, Wand2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import MobileSheet from '@/mobile/ui/MobileSheet';
import { scopeLabel, type ScopeRef } from '@/lib/memory';
import { useConnectionStore } from '@/stores/connectionStore';
import { useMemoryAssistantStore } from '@/stores/memoryAssistantStore';
import { useAssistantModel } from './useAssistantModel';
import MemoryAssistantPanel from './MemoryAssistantPanel';
import { assistantSuggestions } from './assistantSuggestions';

interface Props {
  /** 管理页当前筛到的作用域：助手默认围绕它整理。 */
  focus: ScopeRef | null;
  mobile?: boolean;
}

/**
 * 设置页里的「整理助手」入口：一句话介绍 + 几个起手式 + 打开按钮；对话本身在弹窗
 * （桌面）/ 底部面板（手机）里进行。
 *
 * 为什么不把对话直接铺在设置页里：对话会越聊越长，铺在页面里要么撑得页面很长，要么
 * 给它套一个固定高度的滚动框——页面一个滚动条、里面又一个，手指/滚轮落在哪个上都不对。
 * 放进弹窗，对话记录就是弹窗里唯一的滚动容器，输入框钉在底部（和可视化「内嵌放不下就
 * 全屏查看」是同一个思路：滚动的事交给专门的容器）。
 *
 * 对话状态在 `memoryAssistantStore`：关掉弹窗它照常跑，回来对话和结果都在；这里的按钮
 * 会显示「整理中…」，免得用户以为关掉就停了。
 */
export default function MemoryAssistantLauncher({ focus, mobile = false }: Props) {
  const [open, setOpen] = useState(false);
  const entries = useMemoryAssistantStore((s) => s.entries);
  const running = useMemoryAssistantStore((s) => s.runningId !== null);
  const connections = useConnectionStore((s) => s.connections);
  const focusLabel = focus ? scopeLabel(focus, connections) : null;
  const { label: modelLabel } = useAssistantModel();

  const start = (prompt: string) => {
    void useMemoryAssistantStore.getState().send(prompt, focus);
    setOpen(true);
  };

  const label = running ? '整理中…查看进度' : entries.length > 0 ? '继续上次的对话' : '打开整理助手';

  return (
    <div className="flex flex-col gap-3">
      {entries.length === 0 && (
        <div className="flex flex-wrap gap-2">
          {assistantSuggestions(focusLabel).map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => start(s.prompt)}
              className={`rounded-full border border-edge bg-surface-raised/60 text-fg-secondary transition hover:border-indigo-500/50 hover:text-fg ${
                mobile ? 'px-3 py-2 text-meta' : 'px-3 py-1 text-meta'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`flex items-center justify-center gap-2 self-start rounded-full bg-indigo-600 font-medium text-white transition hover:bg-indigo-500 ${
          mobile ? 'min-h-11 px-5 text-body' : 'px-4 py-2 text-meta'
        }`}
      >
        {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Wand2 className="h-3.5 w-3.5" aria-hidden />}
        {label}
      </button>
      {/* 用哪个模型要写明：整理要读很多记忆和历史会话，花的是真钱。对话框里可以换。 */}
      <p className="text-meta text-fg-tertiary">
        {modelLabel ? `将用「${modelLabel}」整理，打开后可以换` : '还没有配置模型，请先到「设置 → 模型」添加'}
      </p>

      {mobile ? (
        <MobileSheet
          open={open}
          onClose={() => setOpen(false)}
          title="整理助手"
          maxHeightClassName="h-[min(85dvh,calc(100dvh-var(--ime-bottom,0px)))]"
        >
          <MemoryAssistantPanel focus={focus} mobile />
        </MobileSheet>
      ) : (
        <Modal open={open} onClose={() => setOpen(false)} title="整理助手" size="xl" contentClassName="!max-w-2xl">
          <MemoryAssistantPanel focus={focus} />
        </Modal>
      )}
    </div>
  );
}
