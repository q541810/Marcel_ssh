/**
 * URL 参数解析工具
 * 用于支持新窗口 standalone 模式（拖拽拆分终端标签页）
 */

export interface UrlParams {
  standalone: boolean;
  sessionId: string | null;
}

/**
 * 解析当前窗口 URL 参数
 */
export function parseUrlParams(): UrlParams {
  const searchParams = new URLSearchParams(window.location.search);
  const standalone = searchParams.get('standalone') === 'true';
  const sessionId = searchParams.get('sessionId');

  return {
    standalone,
    sessionId,
  };
}

/**
 * 构建新窗口 URL
 */
export function buildStandaloneWindowUrl(sessionId: string): string {
  const baseUrl = window.location.origin + window.location.pathname;
  const params = new URLSearchParams({
    standalone: 'true',
    sessionId,
  });
  return `${baseUrl}?${params.toString()}`;
}