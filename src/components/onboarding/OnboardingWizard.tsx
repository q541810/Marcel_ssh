import { useState, useCallback } from 'react';
import { AlertCircle, Bot, ChevronLeft, ChevronRight, Check, FolderOpen, Monitor } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useSettingsStore } from '@/stores/settingsStore';
import { APP_NAME, APP_LOGO } from '@/lib/constants';
import { ModelServiceSection } from '@/components/settings/ModelServiceSection';
import { AgentPolicySection } from '@/components/settings/AgentPolicySection';
import { SettingsActionsProvider, useValidators } from '@/components/settings/SettingsActionsContext';
import { SearchRegistryProvider } from '@/components/settings/helpers';
import type { AppSettings } from '@/lib/types';

/** 被 OnboardingWizard 复用自有完整功能的设置页组件，修改 Section 时注意两侧同步 */

interface Step {
  id: string;
  title: string;
  component: React.ReactNode;
}

function WelcomeStep() {
  return (
    <div className="text-center">
      <img
        src={APP_LOGO}
        alt={`${APP_NAME} logo`}
        className="w-16 h-16 mx-auto mb-4 object-contain select-none"
        draggable="false"
      />
      <h1 className="text-2xl font-bold text-zinc-100 mb-2">{APP_NAME}</h1>
      <p className="text-zinc-400">小白也能上手的专业级 AI-Native SSH</p>

      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex justify-center mb-2">
            <Monitor className="w-7 h-7 text-zinc-300" />
          </div>
          <div className="text-sm font-medium text-zinc-200">智能终端</div>
          <div className="text-xs text-zinc-500 mt-1">多会话管理</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex justify-center mb-2">
            <Bot className="w-7 h-7 text-zinc-300" />
          </div>
          <div className="text-sm font-medium text-zinc-200">AI Agent</div>
          <div className="text-xs text-zinc-500 mt-1">自动执行命令</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex justify-center mb-2">
            <FolderOpen className="w-7 h-7 text-zinc-300" />
          </div>
          <div className="text-sm font-medium text-zinc-200">文件管理</div>
          <div className="text-xs text-zinc-500 mt-1">SFTP 传输</div>
        </div>
      </div>
    </div>
  );
}

function ModelConfigStep() {
  return (
    <div>
      <h2 className="text-lg font-semibold text-zinc-100 mb-1">配置 AI 模型</h2>
      <p className="text-sm text-zinc-500 mb-6">设置 LLM 服务以启用 Agent 功能</p>
      <ModelServiceSection />
    </div>
  );
}

function AgentOptionsStep() {
  return (
    <div>
      <h2 className="text-lg font-semibold text-zinc-100 mb-1">配置 Agent 行为</h2>
      <p className="text-sm text-zinc-500 mb-6">控制 AI 如何执行命令</p>
      <AgentPolicySection />
    </div>
  );
}

function TerminalTutorialStep() {
  return (
    <div>
      <h2 className="text-lg font-semibold text-zinc-100 mb-1">终端操作指南</h2>
      <p className="text-sm text-zinc-500 mb-6">快速掌握基本操作</p>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 divide-y divide-zinc-800 mb-4">
        <div className="px-6 py-4">
          <div className="flex items-center gap-6">
            <div className="flex-shrink-0 w-32 text-sm font-medium text-zinc-200">Ctrl+C</div>
            <div className="text-sm text-zinc-300">中断当前命令 / 复制选中文本</div>
          </div>
        </div>
        <div className="px-6 py-4">
          <div className="flex items-center gap-6">
            <div className="flex-shrink-0 w-32 text-sm font-medium text-zinc-200">Ctrl+V</div>
            <div className="text-sm text-zinc-300">粘贴</div>
          </div>
        </div>
        <div className="px-6 py-4">
          <div className="flex items-center gap-6">
            <div className="flex-shrink-0 w-32 text-sm font-medium text-zinc-200">右键</div>
            <div className="text-sm text-zinc-300">粘贴</div>
          </div>
        </div>
        <div className="px-6 py-4">
          <div className="flex items-center gap-6">
            <div className="flex-shrink-0 w-32 text-sm font-medium text-zinc-200">Ctrl+D</div>
            <div className="text-sm text-zinc-300">关闭当前会话</div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
        <div className="text-sm text-zinc-300 space-y-2">
          <p>• 点击 + 按钮创建新会话</p>
          <p>• 点击标签页切换会话</p>
          <p>• 每个会话独立连接</p>
        </div>
      </div>
    </div>
  );
}

const STEPS: Step[] = [
  { id: 'welcome', title: '欢迎', component: <WelcomeStep /> },
  { id: 'model', title: '模型', component: <ModelConfigStep /> },
  { id: 'agent', title: 'Agent', component: <AgentOptionsStep /> },
  { id: 'terminal', title: '终端', component: <TerminalTutorialStep /> },
];

interface OnboardingWizardProps {
  open: boolean;
  onComplete: () => void;
}

type TransitionDirection = 'forward' | 'backward';

export default function OnboardingWizard({ open, onComplete }: OnboardingWizardProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  // 翻页方向：用于决定入场动画从左还是从右滑入
  const [direction, setDirection] = useState<TransitionDirection>('forward');
  const fullSettings = useSettingsStore((s) => s.settings);
  const persist = useSettingsStore((s) => s.update);
  const { registerValidator, runValidators } = useValidators();

  const clearValidationErrors = useCallback(() => setValidationErrors([]), []);

  // 被复用方：设置页的 ModelServiceSection / AgentPolicySection 内部用
  // SettingsActionsContext（draft 模式），所以外层提供 Provider 接入 store。
  // 点击导航按钮时调用 persist() 持久化到后端，替代"保存"按钮的职责。
  const providerValue = {
    settings: fullSettings,
    update: persist,
    setPreview: () => {},
    saving: false,
    saveError: null as string | null,
    validationErrors,
    registerValidator,
    clearValidationErrors,
  };

  const validateBeforeProceed = useCallback((): boolean => {
    const errors = runValidators(fullSettings);
    if (errors.length > 0) {
      setValidationErrors(errors);
      return false;
    }
    setValidationErrors([]);
    return true;
  }, [runValidators, fullSettings]);

  const handleNext = useCallback(() => {
    if (!validateBeforeProceed()) return;
    if (currentStep < STEPS.length - 1) {
      setDirection('forward');
      setCurrentStep(currentStep + 1);
    }
  }, [currentStep, validateBeforeProceed]);

  const handlePrev = useCallback(() => {
    setValidationErrors([]);
    if (currentStep > 0) {
      setDirection('backward');
      setCurrentStep(currentStep - 1);
    }
  }, [currentStep]);

  const handleComplete = useCallback(async () => {
    if (!validateBeforeProceed()) return;
    try {
      await persist({ hasCompletedOnboarding: true });
      onComplete();
    } catch (err) {
      console.error('Failed to save onboarding status:', err);
      onComplete();
    }
  }, [persist, onComplete, validateBeforeProceed]);

  const handleSkip = useCallback(async () => {
    setValidationErrors([]);
    try {
      await persist({ hasCompletedOnboarding: true });
      onComplete();
    } catch (err) {
      console.error('Failed to save onboarding status:', err);
      onComplete();
    }
  }, [persist, onComplete]);

  if (!open) return null;

  return (
    <SearchRegistryProvider>
      <SettingsActionsProvider value={providerValue}>
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="modal-backdrop-enter absolute inset-0 bg-zinc-900/95 backdrop-blur-sm" />

          <div className="modal-panel-enter relative w-full max-w-2xl mx-4 flex flex-col max-h-[80vh]">
            {/* Progress bar */}
            <div className="flex items-center justify-center gap-2 mb-6 flex-shrink-0">
              {STEPS.map((step, index) => (
                <div key={step.id} className="flex items-center">
                  <div
                    className={`
                      w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium
                      transition-all duration-300
                      ${index === currentStep
                        ? 'bg-indigo-600 text-white scale-110'
                        : index < currentStep
                          ? 'bg-indigo-600/50 text-indigo-200'
                          : 'bg-zinc-800 text-zinc-500'
                      }
                    `}
                  >
                    {index < currentStep ? (
                      <Check className="w-4 h-4" />
                    ) : (
                      index + 1
                    )}
                  </div>
                  {index < STEPS.length - 1 && (
                    <div
                      className={`w-16 h-0.5 mx-2 transition-colors duration-300 ${
                        index < currentStep ? 'bg-indigo-600/50' : 'bg-zinc-800'
                      }`}
                    />
                  )}
                </div>
              ))}
            </div>

            {/* 翻页后左上角 logo + "新手引导"标题（welcome 页不显示）
                不加 key：仅在首次从 welcome 进入步骤页时挂载一次，避免每页重播滑出动画 */}
            {currentStep > 0 && (
              <div className="flex items-center gap-2.5 mb-5 flex-shrink-0">
                <img
                  src={APP_LOGO}
                  alt={`${APP_NAME} logo`}
                  className="w-8 h-8 object-contain select-none onboarding-logo-enter"
                  draggable="false"
                />
                <span className="text-base font-semibold text-zinc-100 onboarding-title-slide">新手引导</span>
              </div>
            )}

            {/* Step content - scrollable */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 mb-6">
              <div
                key={currentStep}
                className={direction === 'backward'
                  ? 'onboarding-step-backward'
                  : 'onboarding-step-forward'}
              >
                {STEPS[currentStep].component}
              </div>
            </div>

            {/* Validation errors */}
            {validationErrors.length > 0 && (
              <div className="mb-4 space-y-0.5 flex-shrink-0">
                {validationErrors.map((err, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-xs text-red-400">
                    <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                    <span>{err}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Navigation buttons */}
            <div className={currentStep === 0 ? 'flex flex-col items-center gap-3 flex-shrink-0' : 'flex items-center justify-between flex-shrink-0'}>
              {currentStep === 0 ? (
                <>
                  <Button
                    variant="primary"
                    size="lg"
                    onClick={handleNext}
                    className="w-48"
                  >
                    开始使用
                  </Button>
                  <Button
                    variant="secondary"
                    size="lg"
                    onClick={handleSkip}
                    className="w-48"
                  >
                    我会用，无需教学
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    onClick={handleSkip}
                  >
                    跳过
                  </Button>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      onClick={handlePrev}
                    >
                      <ChevronLeft className="w-4 h-4" />
                      上一步
                    </Button>
                    {currentStep < STEPS.length - 1 ? (
                      <Button
                        variant="primary"
                        onClick={handleNext}
                      >
                        下一步
                        <ChevronRight className="w-4 h-4" />
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        onClick={handleComplete}
                      >
                        完成
                        <Check className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </SettingsActionsProvider>
    </SearchRegistryProvider>
  );
}
