/**
 * 联网工具（`web_search` / `http_get`）结果里的「后端 / 降级 / 被拦截」信号读取。
 *
 * 后端把这些信息放在工具结果的 `metadata` 里（字段为可选、且向后兼容旧会话，
 * 旧数据没有任何新字段），这里集中做**防御式**解析：
 *  - `metadata` 在前端类型是 `Record<string, unknown>`，任何字段都可能缺失或
 *    类型不符，因此一律逐字段收窄，绝不做非空断言；
 *  - 旧会话回放时没有这些字段 → 返回 `null` / 空数组，界面维持原样，不显示任何
 *    提示（"兼容旧数据" = 保持原样，不是补一个假状态）。
 *
 * 为什么需要它：这两个工具的结果里"用的是哪个后端、有没有降级、页面是不是被
 * 风控拦了"过去完全不展示，用户只能看到一段正文或一个空的 pre，于是只能得出
 * "网页获取失败"这种无法定位的描述。
 *
 * 「哪些工具算联网工具」不在这里判断 —— 那是工具呈现规格，以
 * `@/lib/toolCatalog` 的表为准（本模块只消费它）。
 */

import { collectPlatformHints, isMobilePlatform } from '@/platform';
import { toolSpec } from '@/lib/toolCatalog';

/** 已知后端标签（后端 `web_result::WebBackend` / `web_search` 的 provider 取值）。 */
export type WebBackendName = 'browser' | 'html' | 'api' | 'mixed' | string;

export interface WebFallback {
  from: string;
  to: string;
  reason: string;
}

export type WebInterceptionKind = 'challenge' | 'not-a-results-page';

export interface WebInterception {
  kind: WebInterceptionKind;
  /** 风控供应商/页面名，例如「百度安全验证」「Cloudflare」。 */
  vendor?: string;
  /** `not-a-results-page` 时的页面描述。 */
  detail?: string;
}

export interface WebPageSummary {
  url: string;
  provider?: string;
  /** 真实 HTTP 状态；浏览器模式拿不到响应时为 `null`（不是 200）。 */
  status: number | null;
  /** 被识别为验证页时的名称。 */
  challenge?: string;
  /** 页面加载了但没有任何可读正文。 */
  blankContent: boolean;
  httpError: boolean;
}

export interface WebToolStatus {
  /** 实际服务本次请求的后端。 */
  provider?: string;
  /** 用户设置里要求使用的后端；下载等正常分流也可能与实际后端不同。 */
  requestedMode?: string;
  fallback?: WebFallback;
  interception?: WebInterception;
  pages: WebPageSummary[];
  /** 被风控/验证页拦下的页面数（http_get 批量时用）。 */
  blockedPages: number;
  /** 加载成功但正文为空的页面数。 */
  blankPages: number;
  /** 后端给出的最终请求计数；缺失或损坏时不补零。 */
  failedCount?: number;
  successCount?: number;
  /** 工具结果的最终成功标记；执行中不传。 */
  finalSuccess?: boolean;
  /** 发生了失败接管；旧结果缺少显式字段时按后端差异推断。 */
  degraded: boolean;
}

const BACKEND_LABELS: Record<string, string> = {
  browser: '本机浏览器',
  html: '裸抓 HTML',
  mixed: '混合后端',
  'api:brave': 'Brave 搜索 API',
  'api:tavily': 'Tavily 搜索 API',
};

/** 后端展示名；未知取值原样返回（便于将来加后端时不会显示成空白）。 */
export function backendLabel(name: string | undefined): string {
  if (!name) return '';
  return BACKEND_LABELS[name] ?? name;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

function readFallback(v: unknown): WebFallback | undefined {
  if (!isRecord(v)) return undefined;
  const from = str(v.from);
  const to = str(v.to);
  if (!from || !to) return undefined;
  return { from, to, reason: str(v.reason) ?? '' };
}

function readInterception(v: unknown): WebInterception | undefined {
  if (!isRecord(v)) return undefined;
  const kind = str(v.kind);
  if (kind !== 'challenge' && kind !== 'not-a-results-page') return undefined;
  return { kind, vendor: str(v.vendor), detail: str(v.detail) };
}

function readPages(v: unknown): WebPageSummary[] {
  if (!Array.isArray(v)) return [];
  const pages: WebPageSummary[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) continue;
    const url = str(raw.url) ?? str(raw.final_url);
    const status = num(raw.status);
    // 一条页面记录至少要有可识别身份（URL）或状态；两者都没有的垃圾条目直接
    // 丢弃——否则它会变成一条 url 为空、状态未知的"页面"，把界面和判定都带偏。
    if (url === undefined && status === undefined) continue;
    pages.push({
      url: url ?? '',
      provider: str(raw.provider),
      status: status ?? null,
      challenge: str(raw.challenge),
      // 旧数据没有该字段 → 视为"有内容"，绝不误报为空正文。
      blankContent: raw.blank_content === true,
      httpError: raw.http_error === true,
    });
  }
  return pages;
}

/**
 * 只有带 `web` 声明的工具（catalog 里是 `web_search` / `http_get`）才有后端/降级
 * 语义；其他工具返回 `null`，界面不显示任何额外信息。**「哪些工具算联网工具」不在
 * 这里复述** —— 那边加减工具时这行文字不会跟着变，以 catalog 的表为准。
 */
export function isWebTool(toolName: string): boolean {
  return toolSpec(toolName)?.web === true;
}

/**
 * 配置的后端在本平台是否根本不存在。
 *
 * 手机端没有本机浏览器可走 CDP，后端的 `resolve_search_config` / `resolve_fetch_mode`
 * 会把设置里的 `browser` 落到裸抓上。这不是降级：用户在手机上**无从选择**本机浏览器
 * （`MobileAgentToolsSection` 只提供裸抓与 API），而 Android 全新安装的默认值就是
 * `browser`，于是每次搜索都会顶着「已降级 / 设置要求：本机浏览器」的标记，提示用户去改
 * 一个他改不了的设置。这里把它归为「平台本来就提供不了」，由显式 `fallback` 负责真正的
 * 降级判定。
 *
 * 桌面端不进这个分支：那里的 `browser` 是可选可用的，provider 不符就是降级。
 */
function modeUnavailableOnThisPlatform(requested: string, provider: string): boolean {
  if (!isMobilePlatform(collectPlatformHints())) return false;
  return requested === 'browser' && provider === 'html';
}

function readStatus(metadata: unknown, finalSuccess?: boolean): WebToolStatus {
  const meta = isRecord(metadata) ? metadata : {};
  let provider = str(meta.provider);
  const requestedMode = str(meta.requested_mode);
  const fallback = readFallback(meta.fallback);
  const pages = readPages(meta.pages);
  // 旧批次可能把部分 HTTP 接管误记成整批 html。仅在全部页面身份、后端信息
  // 都完整时修正；缺项、坏数据或未知后端不猜测，保留原有顶层值。
  if (
    (provider === 'html' || provider === 'browser') &&
    Array.isArray(meta.pages) && meta.pages.length === pages.length &&
    pages.every((page) => page.provider === 'browser' || page.provider === 'html') &&
    pages.some((page) => page.provider === 'browser') &&
    pages.some((page) => page.provider === 'html')
  ) {
    provider = 'mixed';
  }
  const blockedPages = pages.filter((p) => !!p.challenge).length;
  const blankPages = pages.filter((p) => p.blankContent).length;

  // 新结果显式区分失败接管与正常下载读取。旧数据缺少 degraded 时保留原来的
  // 后端差异推断；真正的 fallback 仍是证据，不能被矛盾的 false 字段掩盖。
  const modeMismatch =
    !!provider &&
    !!requestedMode &&
    provider !== requestedMode &&
    !modeUnavailableOnThisPlatform(requestedMode, provider);
  const degraded = !!fallback || (typeof meta.degraded === 'boolean' ? meta.degraded : modeMismatch);

  return {
    provider,
    requestedMode,
    fallback,
    interception: readInterception(meta.interception),
    pages,
    blockedPages,
    blankPages,
    failedCount: count(meta.failed),
    successCount: count(meta.success),
    finalSuccess,
    degraded,
  };
}

/**
 * 读取联网工具的状态；非联网工具或没有可用信号时返回 `null`。
 */
export function readWebToolStatus(
  toolName: string,
  metadata?: Record<string, unknown>,
  finalSuccess?: boolean,
): WebToolStatus | null {
  if (!isWebTool(toolName)) return null;
  const status = readStatus(metadata, finalSuccess);
  const hasSignal =
    !!status.provider ||
    !!status.requestedMode ||
    !!status.fallback ||
    !!status.interception ||
    status.pages.length > 0 ||
    (status.failedCount ?? 0) > 0 ||
    status.finalSuccess === false;
  return hasSignal ? status : null;
}

export type ChipTone = 'neutral' | 'warning' | 'danger';

export interface StatusChip {
  key: string;
  label: string;
  tone: ChipTone;
  /** 可选快捷提示；同样的信息在可展开详情中提供给触摸与键盘用户。 */
  title?: string;
}

/**
 * 卡片标题行右侧的状态小标记。
 *
 * 获取方式与成功恢复合并为一个中性标记，最终仍失败的结果才使用警告色。
 */
export function webToolChips(status: WebToolStatus): StatusChip[] {
  const chips: StatusChip[] = [];

  const actualProvider = status.provider ?? status.fallback?.to;
  const providerTitle = status.requestedMode && status.requestedMode !== actualProvider
    ? `设置要求：${backendLabel(status.requestedMode)}；实际使用：${backendLabel(actualProvider)}`
    : `实际使用：${backendLabel(actualProvider)}`;
  const specificFailure = webToolNotice(status);
  const hasFailure = (status.failedCount ?? 0) > 0 || status.finalSuccess === false || !!specificFailure;
  if (hasFailure && !specificFailure) {
    chips.push({
      key: 'failed',
      label: (status.successCount ?? 0) > 0 || status.finalSuccess === true ? '部分获取失败' : '获取失败',
      tone: 'warning',
      title: '仍有请求未获取到可用结果，展开可查看输出与详情',
    });
  } else if (status.degraded && !hasFailure) {
    chips.push({
      key: 'fallback',
      label: actualProvider === 'mixed' ? '部分已切换' : '已切换方式',
      tone: 'neutral',
      title: actualProvider ? providerTitle : '已自动切换获取方式，展开可查看详情',
    });
  } else if (actualProvider) {
    chips.push({
      key: 'provider',
      label: backendLabel(actualProvider),
      tone: 'neutral',
      title: `实际使用：${backendLabel(actualProvider)}`,
    });
  }

  if (status.interception) {
    chips.push({
      key: 'interception',
      label: '被网站拦截',
      tone: 'warning',
      title: interceptionTitle(status.interception),
    });
  } else if (status.blockedPages > 0) {
    chips.push({
      key: 'blocked-pages',
      label: `${status.blockedPages} 个页面被网站拦截`,
      tone: 'warning',
      title: '这些页面返回的是人机验证页，不是正文',
    });
  }

  return chips;
}

/** 按需展开的诊断信息；方式切换本身不代表内容质量下降。 */
export function webToolDetails(status: WebToolStatus): string[] {
  const lines: string[] = [];
  const provider = status.provider ?? status.fallback?.to;
  if (provider) lines.push(`实际使用：${backendLabel(provider)}`);
  if (status.degraded && status.requestedMode && status.requestedMode !== provider) {
    lines.push(`设置要求：${backendLabel(status.requestedMode)}`);
  }
  if (status.fallback) {
    lines.push(`${backendLabel(status.fallback.from)}未完成的请求，已尝试改用${backendLabel(status.fallback.to)}获取。`);
    if (status.fallback.reason) lines.push(`原因：${status.fallback.reason}`);
  }
  if (provider === 'mixed') {
    for (const page of status.pages) {
      if (page.url && page.provider) lines.push(`${page.url} — ${backendLabel(page.provider)}`);
    }
  }
  return lines;
}

function interceptionTitle(interception: WebInterception): string {
  if (interception.kind === 'challenge') {
    return `搜索引擎返回了人机验证页${interception.vendor ? `（${interception.vendor}）` : ''}，不是搜索结果`;
  }
  return `返回的页面不是搜索结果页${interception.detail ? `：${interception.detail}` : ''}`;
}

export interface StatusNotice {
  tone: 'warning' | 'danger';
  title: string;
  lines: string[];
}

/**
 * 对最终结果仍不可用的情况给出说明；已恢复的获取方式切换仅放在详情中。
 */
export function webToolNotice(status: WebToolStatus): StatusNotice | null {
  if (status.interception) {
    const lines: string[] = [];
    if (status.interception.kind === 'challenge') {
      lines.push(
        `搜索引擎返回的是人机验证页${status.interception.vendor ? `（${status.interception.vendor}）` : ''}，并不是搜索结果。`,
        '重复同一查询通常无效：可在「设置 → 联网搜索方式」改用搜索 API，或稍后重试。',
      );
    } else {
      lines.push(
        '请求没有拿到搜索结果页，可能是网络/代理问题或搜索引擎改版。',
        status.interception.detail ? `页面信息：${status.interception.detail}` : '',
      );
    }
    return {
      tone: 'warning',
      title: '搜索被网站拦截',
      lines: lines.filter(Boolean),
    };
  }

  const blocked = status.pages.filter((p) => !!p.challenge);
  if (blocked.length > 0) {
    return {
      tone: 'warning',
      title: `${blocked.length} 个页面被网站拦截`,
      lines: [
        '以下页面返回的是人机验证页，不是正文；已按失败处理。',
        ...blocked.map((p) => `${p.url}${p.challenge ? ` — ${p.challenge}` : ''}`),
      ],
    };
  }

  if (status.blockedPages === 0 && status.blankPages > 0 && status.pages.length === status.blankPages) {
    return {
      tone: 'warning',
      title: '页面没有可读内容',
      lines: [
        '页面已加载，但转换后没有任何可读正文——可能依赖 JavaScript 渲染，或本身是空壳页。',
      ],
    };
  }

  return null;
}

export interface WebGroupSummary {
  /** 组内发生降级的工具调用数。 */
  degraded: number;
  /** 组内被拦截/含被拦截页面的工具调用数。 */
  blocked: number;
}

/**
 * 汇总一组（可能被折叠的）联网工具调用的异常，供分组标题使用。
 * 全组正常时两个计数都为 0，标题保持原样。
 */
export function summarizeWebToolGroup(
  messages: Array<{ toolName: string; metadata?: Record<string, unknown> }>,
): WebGroupSummary {
  let degraded = 0;
  let blocked = 0;
  for (const m of messages) {
    const status = readWebToolStatus(m.toolName, m.metadata);
    if (!status) continue;
    if (status.degraded) degraded += 1;
    if (status.interception || status.blockedPages > 0) blocked += 1;
  }
  return { degraded, blocked };
}

/** 后端可能拿不到真实 HTTP 状态；显示时不要伪造 200。 */
export function formatPageStatus(page: WebPageSummary): string {
  if (page.status === null) return '状态未知（无 HTTP 响应）';
  return `${page.status}`;
}
