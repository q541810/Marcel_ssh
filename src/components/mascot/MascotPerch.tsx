import { memo, useCallback } from 'react';
import MarcelSprite from './MarcelSprite';
import { useMascotMood } from './useMascotMood';
import type { MascotState } from '@/lib/mascot/frames';

/** 坐姿玛瑟尔的目标尺寸（CSS px，整张 64 格画布）。实际按整数倍像素落在附近。 */
export const PERCH_SIZE = 64;
/**
 * 消息列表底部给玛瑟尔让出的高度：它贴右坐在消息区下沿，最后一行消息滚到底时
 * 不能被它盖住。人物本体约 48 格高，左侧文字只会和它的身子重叠一点，留 44px 足够。
 */
export const PERCH_RESERVE_PX = 44;

/**
 * 坐在消息区右下角、跟着这个对话的任务状态做动作的玛瑟尔。
 * 动作由 `useMascotMood`（导演）定，这里只负责把它摆上去。
 */
export const MascotPerch = memo(function MascotPerch({ conversationId }: { conversationId: string }) {
  const { state, poke } = useMascotMood(conversationId);
  return <MarcelSprite state={state} size={PERCH_SIZE} perch onPoke={poke} />;
});

/** 空白页中间的大图：动作由调用方按连接状态给（`mascotForEmptyState`）。 */
export const MascotHero = memo(function MascotHero({ state, size = 128 }: { state: MascotState; size?: number }) {
  const poke = useCallback(() => {}, []); // 只要弹一下，不改状态
  return (
    <div className="flex justify-center">
      <MarcelSprite state={state} size={size} onPoke={poke} />
    </div>
  );
});
