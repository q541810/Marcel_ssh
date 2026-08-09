import { useCallback, useMemo, useState } from 'react';
import { Bot, ChevronLeft, ChevronRight, CloudDownload, Folder, Sparkles, Terminal } from 'lucide-react';
import { APP_LOGO, APP_NAME } from '@/lib/constants';
import type { AppSettings } from '@/lib/types';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  SettingsActionsProvider,
  useValidators,
} from '@/components/settings/SettingsActionsContext';
import { SyncRestoreFlow } from '@/components/onboarding/SyncRestore';
import { MobileModelSection } from './settings/MobileModelSection';
import MobileFullscreenPage from './ui/MobileFullscreenPage';

interface MobileOnboardingProps {
  onComplete: () => void;
}

type Phase = 'gate' | 'restore' | 'steps';

function GateStep({
  onRestore,
  onFresh,
  onSkip,
}: {
  onRestore: () => void;
  onFresh: () => void;
  onSkip: () => void;
}) {
  return (
    <div
      className="flex min-h-full flex-col px-6 pb-6"
      style={{ paddingTop: 'max(2.5rem, env(safe-area-inset-top, 0px))' }}
    >
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <img
          src={APP_LOGO}
          alt={`${APP_NAME} logo`}
          className="mb-4 h-16 w-16 select-none object-contain"
          draggable={false}
        />
        <h1 className="text-2xl font-bold text-zinc-100">{APP_NAME}</h1>
        <p className="mt-1 text-sm text-zinc-400">口袋里的 AI-Native SSH 终端</p>
      </div>

      <h2 className="mb-3 text-center text-base font-semibold text-zinc-100">
        你有同步账户吗？
      </h2>
      <div className="flex w-full flex-col gap-2">
        <button
          type="button"
          onClick={onRestore}
          className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3.5 text-left active:border-zinc-600"
        >
          <CloudDownload className="h-6 w-6 flex-shrink-0 text-indigo-400" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-zinc-200">有，恢复配置</span>
            <span className="mt-0.5 block text-xs text-zinc-500">
              输入配置码，从同步账户恢复数据
            </span>
          </span>
          <ChevronRight className="h-4 w-4 flex-shrink-0 text-zinc-600" />
        </button>
        <button
          type="button"
          onClick={onFresh}
          className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3.5 text-left active:border-zinc-600"
        >
          <Sparkles className="h-6 w-6 flex-shrink-0 text-indigo-400" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-zinc-200">没有，我是新用户</span>
            <span className="mt-0.5 block text-xs text-zinc-500">完成初始化设置</span>
          </span>
          <ChevronRight className="h-4 w-4 flex-shrink-0 text-zinc-600" />
        </button>
      </div>

      <div className="mt-4 text-center">
        <button
          type="button"
          onClick={onSkip}
          className="rounded-lg px-3 py-2 text-xs text-zinc-500 active:bg-zinc-800 active:text-zinc-300"
        >
          跳过
        </button>
      </div>
    </div>
  );
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
 * Mobile onboarding: 同步门（恢复/新用户）→ welcome → model → touch guide。
 * 恢复成功直接结束引导；与桌面共享 `hasCompletedOnboarding` flag，
 * sections 通过 settings store 即时持久化（无单独 draft）。
 */
export default function MobileOnboarding({
  onComplete,
}: MobileOnboardingProps) {
  const [phase, setPhase] = useState<Phase>('gate');
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

  // Android back：restore → 回同步门；steps → 上一步（第 0 步回同步门）；
  // gate 不注册，back 交给系统（退出应用）。
  const handleBack = useCallback(() => {
    if (phase === 'restore') {
      setPhase('gate');
    } else if (step > 0) {
      setStep((s) => Math.max(0, s - 1));
    } else {
      setPhase('gate');
    }
  }, [phase, step]);

  const isLast = step === STEP_COUNT - 1;
  // gate/restore/step 切换都重挂载内容区，重播入场动画
  const animKey = phase === 'steps' ? `step-${step}` : phase;

  return (
    <SettingsActionsProvider value={actionsValue}>
      <MobileFullscreenPage
        region="mobile-onboarding"
        // gate 阶段不接管 back，交给系统（退出应用）。
        onBack={phase === 'gate' ? undefined : handleBack}
      >
        {/* Header：gate 无头；restore / steps 有返回 */}
        {phase !== 'gate' && (
          <header
            className="flex flex-shrink-0 items-center justify-between px-3 py-2"
            style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top, 0px))' }}
          >
            <button
              type="button"
              onClick={handleBack}
              className="flex h-10 w-10 items-center justify-center rounded-lg text-zinc-400 active:bg-zinc-800"
              aria-label="上一步"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            {phase === 'restore' ? (
              <span className="text-sm font-medium text-zinc-200">恢复配置</span>
            ) : (
              <span className="text-xs text-zinc-500">
                {step + 1} / {STEP_COUNT}
              </span>
            )}
            {phase === 'steps' ? (
              <button
                type="button"
                onClick={() => void finish()}
                className="rounded-lg px-3 py-2 text-xs text-zinc-500 active:bg-zinc-800 active:text-zinc-300"
              >
                跳过
              </button>
            ) : (
              <span className="h-10 w-10" />
            )}
          </header>
        )}

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div key={animKey} className="mobile-panel-enter h-full min-h-full">
            {phase === 'gate' && (
              <GateStep
                onRestore={() => setPhase('restore')}
                onFresh={() => {
                  setStep(0);
                  setPhase('steps');
                }}
                onSkip={() => void finish()}
              />
            )}
            {phase === 'restore' && (
              <div className="px-3 pb-6 pt-2">
                <p className="mb-4 px-1 text-xs text-zinc-500">
                  输入配置码与账户密码，从同步服务器恢复数据
                </p>
                <SyncRestoreFlow onDone={() => void finish()} />
              </div>
            )}
            {phase === 'steps' && step === 0 && <WelcomeStep />}
            {phase === 'steps' && step === 1 && <ModelStep />}
            {phase === 'steps' && step === 2 && <GuideStep />}
          </div>
        </div>

        {/* Footer：仅内容步骤显示 dots + 按钮 */}
        {phase === 'steps' && (
          <footer
            className="flex flex-shrink-0 flex-col gap-3 border-t border-zinc-800 px-4 pt-3 pb-3"
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
        )}
      </MobileFullscreenPage>
    </SettingsActionsProvider>
  );
}
