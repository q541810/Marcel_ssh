/**
 * 更新下载进度的共享计算。
 *
 * 之所以单独抽出来：桌面药丸、移动端细进度条、两端设置页的「检查更新」结果区
 * 都要显示同一个百分比 —— 各算一遍迟早会出现"同一个下载两处数字不一样"。
 * 边界语义也集中在这里：
 * - `total` 未知或为 0（后端还没拿到 Content-Length）→ 0%，不出现 NaN；
 * - 收到的字节超过 `total`（服务端 Content-Length 偏小）→ 封顶 100%，
 *   否则进度条会溢出容器。
 */
export function updatePercent(downloaded: number, total: number): number {
  if (!Number.isFinite(downloaded) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((downloaded / total) * 100));
}

/** 人类可读的 MB 文案（进度提示用，保留一位小数）。 */
export function formatMb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0.0';
  return (bytes / 1024 / 1024).toFixed(1);
}
