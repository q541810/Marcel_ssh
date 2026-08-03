import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { openExternalLink } from '@/lib/externalLinks';
import { useSettingsStore } from '@/stores/settingsStore';
import { dismissStarPrompt, maybeShowStarPromptOnLaunch } from '@/lib/starPrompt';
import MobileSheet from './ui/MobileSheet';

const REPO_URL = 'https://github.com/q541810/Marcel_ssh';

/** 移动端 Star 请求底部浮层：挂载时按启动计数判定一次（每 N 次启动最多
 *  弹一次，可永久忽略）。未完成引导时不弹。 */
export default function MobileStarPromptSheet() {
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
    <MobileSheet
      open={open}
      onClose={handleSkip}
      title="喜欢 Marcel SSH 吗？"
      maxHeightClassName="max-h-[70dvh]"
      footer={
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={handleStar}
            className="w-full rounded-xl bg-indigo-600 px-3 py-3 text-sm font-medium text-white active:bg-indigo-500"
          >
            去 GitHub 点个 Star
          </button>
          <button
            type="button"
            onClick={handleSkip}
            className="w-full rounded-xl bg-zinc-800 px-3 py-3 text-sm font-medium text-zinc-200 active:bg-zinc-700"
          >
            以后再说
          </button>
        </div>
      }
    >
      <div className="flex flex-col items-center gap-3 px-5 py-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-400/10">
          <Star className="h-8 w-8 text-amber-400" fill="currentColor" />
        </div>
        <div>
          <p className="text-base font-semibold text-zinc-100">喜欢 Marcel SSH 吗？</p>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            如果它让 SSH 连接变得更顺手，欢迎去 GitHub 点个 Star ——
            这是对独立开发者最大的支持。
          </p>
        </div>
        <button
          type="button"
          onClick={handleNever}
          className="text-xs text-zinc-600 active:text-zinc-400"
        >
          不再提醒
        </button>
      </div>
    </MobileSheet>
  );
}
