import { useCallback, useMemo, useState } from 'react';
import { Bot, ChevronLeft, Folder, Terminal } from 'lucide-react';
import { APP_LOGO, APP_NAME } from '@/lib/constants';
import type { AppSettings } from '@/lib/types';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  SettingsActionsProvider,
  useValidators,
} from '@/components/settings/SettingsActionsContext';
import { MobileModelSection } from './settings/MobileModelSection';

interface MobileOnboardingProps {
  onComplete: () => void;
}

function WelcomeStep() {
  return (
    <div className="flex flex-col items-center px-6 pt-10 text-center">
      <img
        src={APP_LOGO}
        alt={`${APP_NAME} logo`}
        className="mb-4 h-16 w-16 select-none object-contain"
        draggable={false}
      />
      <h1 className="text-2xl font-bold text-zinc-100">{APP_NAME}</h1>
      <p className="mt-1 text-sm text-zinc-400">口袋里的 AI-Native SSH 终端</p>

      <div className="mt-8 flex w-full flex-col gap-2">
        <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3.5 text-left">
          <Terminal className="h-6 w-6 flex-shrink-0 text-indigo-400" />
          <div>
            <div className="text-sm font-medium text-zinc-200">智能终端</div>
            <div className="mt-0.5 text-xs text-zinc-500">
              触屏辅助键盘与快捷命令
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3.5 text-left">
          <Bot className="h-6 w-6 flex-shrink-0 text-indigo-400" />
          <div>
            <div className="text-sm font-medium text-zinc-200">AI Agent</div>
            <div className="mt-0.5 text-xs text-zinc-500">
              描述需求，自动执行运维任务
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3.5 text-left">
          <Folder className="h-6 w-6 flex-shrink-0 text-indigo-400" />
          <div>
            <div className="text-sm font-medium text-zinc-200">文件管理</div>
            <div className="mt-0.5 text-xs text-zinc-500">
              SFTP 浏览、编辑与传输
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ModelStep() {
  return (
    <div className="px-3 pt-4">
      <div className="px-1 pb-4">
        <h2 className="text-lg font-semibold text-zinc-100">配置 AI 模型</h2>
        <p className="mt-0.5 text-xs text-zinc-500">
          设置 LLM 服务以启用智能助手，也可以稍后在设置中配置
        </p>
      </div>
      <MobileModelSection />
    </div>
  );
}

const TOUCH_GUIDE: { title: string; body: string }[] = [
  {
    title: '辅助键盘',
    body: '终端下方固定两行按键：Esc、Ctrl、方向键、^C、粘贴、回车，无需依赖软键盘符号页',
  },
  {
    title: 'Ctrl 组合键',
    body: '点按 Ctrl 后再输入字母即发送组合键（如 Ctrl+R 搜索历史）',
  },
  {
    title: '快捷命令',
    body: '输入栏上方的命令胶囊一键执行，可在「设置 → 快捷命令」里管理',
  },
  {
    title: '文件操作',
    body: '文件页轻点选中、再点打开；图片支持捏合缩放，文本全屏编辑',
  },
  {
    title: 'Agent 审批',
    body: 'Agent 执行敏感命令时会弹出底部审批卡片，确认后才会执行',
  },
];

function GuideStep() {
  return (
    <div className="px-3 pt-4">
      <div className="px-1 pb-4">
        <h2 className="text-lg font-semibold text-zinc-100">触屏操作指南</h2>
        <p className="mt-0.5 text-xs text-zinc-500">为手机重新设计的交互</p>
      </div>
      <div className="flex flex-col gap-2">
        {TOUCH_GUIDE.map((item) => (
          <div
            key={item.title}
            className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3"
          >
            <div className="text-sm font-medium text-zinc-200">
              {item.title}
            </div>
            <div className="mt-0.5 text-xs leading-relaxed text-zinc-500">
              {item.body}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const STEP_COUNT = 3;

/**
 * Mobile onboarding: welcome → model config → touch guide.
 * Shares the desktop `hasCompletedOnboarding` flag; sections persist
 * immediately through the settings store (no separate draft).
 */
export default function MobileOnboarding({
  onComplete,
}: MobileOnboardingProps) {
  const [step, setStep] = useState(0);
  const settings = useSettingsStore((s) => s.settings);
  const persist = useSettingsStore((s) => s.update);
  const { registerValidator } = useValidators();

  const actionsValue = useMemo(
    () => ({
      settings,
      update: (patch: Partial<AppSettings>) => {
        void persist(patch);
      },
      setPreview: () => {},
      saving: false,
      saveError: null as string | null,
      validationErrors: [] as string[],
      registerValidator,
      clearValidationErrors: () => {},
    }),
    [settings, persist, registerValidator],
  );

  const finish = useCallback(async () => {
    try {
      await persist({ hasCompletedOnboarding: true });
    } catch (err) {
      console.error('Failed to save onboarding status:', err);
    }
    onComplete();
  }, [persist, onComplete]);

  const isLast = step === STEP_COUNT - 1;

  return (
    <SettingsActionsProvider value={actionsValue}>
      <div
        className="mobile-fullscreen-enter fixed inset-0 z-50 flex flex-col bg-zinc-950"
        data-region="mobile-onboarding"
      >
        {/* Header: back + skip */}
        <header
          className="flex flex-shrink-0 items-center justify-between px-3 py-2"
          style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top, 0px))' }}
        >
          {step > 0 ? (
            <button
              type="button"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              className="flex h-10 w-10 items-center justify-center rounded-lg text-zinc-400 active:bg-zinc-800"
              aria-label="上一步"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
          ) : (
            <span className="h-10 w-10" />
          )}
          <button
            type="button"
            onClick={() => void finish()}
            className="rounded-lg px-3 py-2 text-xs text-zinc-500 active:bg-zinc-800 active:text-zinc-300"
          >
            跳过
          </button>
        </header>

        {/* Step body */}
        <div
          key={step}
          className="mobile-panel-enter min-h-0 flex-1 overflow-y-auto pb-4"
        >
          {step === 0 && <WelcomeStep />}
          {step === 1 && <ModelStep />}
          {step === 2 && <GuideStep />}
        </div>

        {/* Footer: dots + next */}
        <footer
          className="flex flex-shrink-0 flex-col gap-3 border-t border-zinc-800 px-4 pt-3"
          style={{
            paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0px))',
          }}
        >
          <div className="flex justify-center gap-1.5" aria-hidden>
            {Array.from({ length: STEP_COUNT }, (_, i) => (
              <span
                key={i}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i === step ? 'w-5 bg-indigo-500' : 'w-1.5 bg-zinc-700'
                }`}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              if (isLast) {
                void finish();
              } else {
                setStep((s) => s + 1);
              }
            }}
            className="w-full rounded-xl bg-indigo-600 px-4 py-3.5 text-sm font-medium text-white transition-transform duration-100 active:scale-[0.99] active:bg-indigo-500"
          >
            {isLast ? '开始使用' : '下一步'}
          </button>
        </footer>
      </div>
    </SettingsActionsProvider>
  );
}
