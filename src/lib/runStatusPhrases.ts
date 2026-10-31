/**
 * 任务运行状态条的文案池：按本地时段分组，随机挑一句。
 *
 * 文案只是装饰，不参与任何状态判断；抽成纯函数是为了能测时段边界
 * 与「不连着抽同一句」。时段口径（本地时间）：
 *   早上 05:00–08:59 / 上午 09:00–11:29 / 中午 11:30–13:29
 *   下午 13:30–17:59 / 晚上 18:00–04:59（跨午夜）
 */
export type RunStatusPeriod =
  | 'earlyMorning'
  | 'forenoon'
  | 'noon'
  | 'afternoon'
  | 'evening';

export const RUN_STATUS_PHRASES: Record<RunStatusPeriod, readonly string[]> = {
  earlyMorning: [
    '制作早饭',
    '与大肥鱼聊天',
    '我是一只自由的邦布',
    '地铁通勤',
    '充电中...',
    '棉拉拉稀还没更新吗',
  ],
  forenoon: [
    '为什么邦布不能喝咖啡',
    '偷吃同事电池',
    '带薪充电',
    '睡一会',
    '邦布为什么不能smoke',
    '假装工作',
  ],
  noon: [
    '偷吃电池',
    '算力中枢局伙食打卡',
    '碰见诺姆了，我跑',
  ],
  afternoon: [
    '严肃下工',
    '毛绒扳手护理中...',
    '与猫咪大战三百回合',
    '充电五分钟，嗯呢两小时',
    '下班通勤中',
  ],
  evening: [
    '呼呼大睡中',
    '偷吃夜宵中',
    '观看鬼片中',
    '深夜开黑中',
    '外卖到了没',
  ],
};

/** 没有新的工具调用/思考时，也会按这个间隔换一句，避免长时间停在同一条。 */
export const RUN_STATUS_ROTATE_MS = 12_000;

/** 按本地时钟把一天分成五段；晚上跨午夜，所以最后一段是兜底。 */
export function runStatusPeriod(date: Date = new Date()): RunStatusPeriod {
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (minutes >= 5 * 60 && minutes < 9 * 60) return 'earlyMorning';
  if (minutes >= 9 * 60 && minutes < 11 * 60 + 30) return 'forenoon';
  if (minutes >= 11 * 60 + 30 && minutes < 13 * 60 + 30) return 'noon';
  if (minutes >= 13 * 60 + 30 && minutes < 18 * 60) return 'afternoon';
  return 'evening';
}

/**
 * 从对应时段里随机挑一句；传入上一句时先把它排除，避免连续两次一样。
 * `random` 可注入，测试里用固定值验证挑选结果。
 */
export function pickRunStatusPhrase(
  period: RunStatusPeriod,
  previous?: string,
  random: () => number = Math.random,
): string {
  const pool = RUN_STATUS_PHRASES[period];
  const candidates = previous ? pool.filter((phrase) => phrase !== previous) : pool;
  const usable = candidates.length > 0 ? candidates : pool;
  return usable[Math.floor(random() * usable.length)] ?? pool[0];
}
