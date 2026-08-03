import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { openExternalLink } from '@/lib/externalLinks';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  dismissStarPrompt,
  maybeShowStarPromptOnInstall,
  maybeShowStarPromptOnLaunch,
} from '@/lib/starPrompt';

const REPO_URL = 'https://github.com/q541810/Marcel_ssh';

/** 市场页「一键安装」成功后派发，触发 Star 弹窗判定（见 StarPromptModal）。 */
export const STAR_PROMPT_INSTALL_EVENT = 'marcel:star-prompt-install';

/** 桌面端 Star 请求弹窗：挂载时按启动计数判定一次；市场安装成功事件
 *  （STAR_PROMPT_INSTALL_EVENT）触发安装点判定。未完成引导时不弹。 */
export default function StarPromptModal() {
  const [open, setOpen] = useState(false);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const hasCompletedOnboarding = useSettingsStore(
    (s) => s.settings.hasCompletedOnboarding,
  );

  useEffect(() => {
    if (settingsLoaded && hasCompletedOnboarding && maybeShowStarPromptOnLaunch()) {
      setOpen(true);
    }
  }, [settingsLoaded, hasCompletedOnboarding]);

  useEffect(() => {
    const onInstall = () => {
      if (maybeShowStarPromptOnInstall()) setOpen(true);
    };
    window.addEventListener(STAR_PROMPT_INSTALL_EVENT, onInstall);
    return () => window.removeEventListener(STAR_PROMPT_INSTALL_EVENT, onInstall);
  }, []);

  const handleStar = () => {
    dismissStarPrompt();
    setOpen(false);
    openExternalLink(REPO_URL);
  };

  const handleSkip = () => {
    setOpen(false);
  };

  const handleNever = () => {
    dismissStarPrompt();
    setOpen(false);
  };

  return (
    <Modal
      open={open}
      onClose={handleSkip}
      size="sm"
      contentClassName="!max-w-[340px] !bg-zinc-900 !border-zinc-800"
    >
      <div className="relative px-4 pb-2">
        <button
          type="button"
          onClick={handleSkip}
          aria-label="关闭"
          className="absolute right-0 top-0 flex h-6 w-6 items-center justify-center rounded-md text-sm leading-none text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
        >
          ✕
        </button>
        <div className="flex flex-col items-center pt-6 pb-1 text-center">
          <div className="flex h-[52px] w-[52px] items-center justify-center rounded-full bg-amber-400/10">
            <Star className="h-[26px] w-[26px] text-amber-400" fill="currentColor" />
          </div>
          <p className="mt-3.5 text-base font-semibold text-zinc-100">
            喜欢 Marcel SSH 吗？
          </p>
          <p className="mt-2 text-[13px] leading-[1.7] text-zinc-400">
            如果它让 SSH 连接变得更顺手，欢迎去 GitHub 点个 Star ——
            这是对独立开发者最大的支持。
          </p>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          <Button
            variant="primary"
            className="w-full !rounded-[10px] !py-2.5"
            onClick={handleStar}
          >
            去 GitHub 点个 Star
          </Button>
          <Button
            variant="secondary"
            className="w-full !rounded-[10px] !py-2.5"
            onClick={handleSkip}
          >
            以后再说
          </Button>
        </div>
        <button
          type="button"
          onClick={handleNever}
          className="mt-3 w-full text-center text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
        >
          不再提醒
        </button>
      </div>
    </Modal>
  );
}
