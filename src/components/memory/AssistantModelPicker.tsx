import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import Select from '@/components/ui/Select';
import { MobileModelPickerSheet } from '@/mobile/settings/MobileModelSection';
import { modelOptionsByChannel } from '@/lib/llmRegistry';
import { unchosenLabel } from '@/lib/memoryAssistantModel';
import { useMemoryAssistantStore } from '@/stores/memoryAssistantStore';
import { useAssistantModel } from './useAssistantModel';

/**
 * 整理助手用哪个模型：对话框顶部一行，用户自己选。不选就沿用「设置 → 记忆」里的记忆模型，
 * 那边也没设就用默认模型——选项文字里直接写明落到哪个模型，不让人猜。
 *
 * 选择只存本机、立刻生效（下一句话起用它），不经设置页的「保存」，也不改后台复盘用的记忆模型。
 */
export default function AssistantModelPicker({ mobile = false }: { mobile?: boolean }) {
  const { registry, chosenId, choice, label } = useAssistantModel();
  const [sheet, setSheet] = useState(false);
  const running = useMemoryAssistantStore((s) => s.runningId !== null);
  const setModelId = (id: string) => useMemoryAssistantStore.getState().setModelId(id);
  const options = useMemo(
    () => [{ value: '', label: unchosenLabel(registry) }, ...modelOptionsByChannel(registry)],
    [registry],
  );

  const hint = choice.source === 'chosen' ? '' : choice.source === 'none' ? '' : '（未单独选）';
  return (
    <div className="flex min-w-0 flex-shrink-0 items-center gap-2 border-b border-edge/70 px-4 py-2 text-meta text-fg-secondary">
      <span className="flex-shrink-0">用这个模型整理</span>
      {mobile ? (
        <>
          <button
            type="button"
            disabled={running}
            onClick={() => setSheet(true)}
            className="flex min-h-9 min-w-0 flex-1 items-center justify-between gap-2 rounded-lg border border-edge bg-fill px-3 text-left text-body text-fg active:bg-state-mid disabled:opacity-50"
          >
            <span className="truncate">
              {label || '尚未配置模型'}
              {hint && <span className="text-fg-tertiary">{hint}</span>}
            </span>
            <ChevronDown className="h-4 w-4 flex-shrink-0 text-fg-tertiary" aria-hidden />
          </button>
          <MobileModelPickerSheet
            open={sheet}
            onClose={() => setSheet(false)}
            title="整理助手用的模型"
            registry={registry}
            value={chosenId}
            allowEmpty
            emptyLabel={unchosenLabel(registry)}
            onChange={setModelId}
          />
        </>
      ) : (
        <Select value={chosenId} onChange={setModelId} options={options} disabled={running} className="min-w-0 flex-1 [&_button]:py-1 [&_button]:text-meta" />
      )}
    </div>
  );
}
