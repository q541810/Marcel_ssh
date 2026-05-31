import type { AppSettings } from '@/lib/types';
import Toggle from '@/components/ui/Toggle';
import { Section, Field } from './helpers';

interface DisplaySectionProps {
  settings: AppSettings;
  updateDraft: (mutator: (s: AppSettings) => AppSettings) => void;
}

export function DisplaySection({ settings, updateDraft }: DisplaySectionProps) {
  return (
    <Section
      id="settings-display"
      title="显示"
      description="自定义界面显示方式"
    >
      <Field label="模型思考">
        <Toggle
          checked={settings.hideThinkingDisplay}
          onChange={(checked) => {
            updateDraft((s) => ({
              ...s,
              hideThinkingDisplay: checked,
            }));
          }}
          label="不显示模型的思考过程"
        />
      </Field>
      <div className="ml-36">
        <p className="text-xs text-zinc-500">
          开启后将隐藏模型的推理/思考内容。后端仍会处理这些内容以满足某些模型（如 DeepSeek）的 API 要求。
        </p>
      </div>
    </Section>
  );
}
