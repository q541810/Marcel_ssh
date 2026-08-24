import { memo } from "react";

function MobileVisualizationUnavailable() {
  return (
    <div className="my-2 w-full rounded-lg border border-zinc-800/80 bg-zinc-900/30 px-3 py-2.5 text-sm text-zinc-400">
      交互可视化仅支持桌面端，请在桌面端查看。
    </div>
  );
}

export default memo(MobileVisualizationUnavailable);
