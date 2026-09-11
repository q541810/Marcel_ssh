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
 */

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
  /** 用户设置里要求使用的后端（与 provider 不同 = 发生了降级）。 */
  requestedMode?: string;
  fallback?: WebFallback;
  interception?: WebInterception;
  pages: WebPageSummary[];
  /** 被风控/验证页拦下的页面数（http_get 批量时用）。 */
  blockedPages: number;
  /** 加载成功但正文为空的页面数。 */
  blankPages: number;
  /** 后端与请求的后端不一致（含 fallback 显式声明的情况）。 */
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
      status: status ?? null,
      challenge: str(raw.challenge),
      // 旧数据没有该字段 → 视为"有内容"，绝不误报为空正文。
      blankContent: raw.blank_content === true,
      httpError: raw.http_error === true,
    });
  }
  return pages;
}

/** 这两个工具才有后端/降级语义；其他工具返回 `null`，界面不显示任何额外信息。 */
export function isWebTool(toolName: string): boolean {
  return toolName === 'web_search' || toolName === 'http_get';
}

function readStatus(metadata: unknown): WebToolStatus {
  const meta = isRecord(metadata) ? metadata : {};
  const provider = str(meta.provider);
  const requestedMode = str(meta.requested_mode);
  const fallback = readFallback(meta.fallback);
  const pages = readPages(meta.pages);
  const blockedPages = pages.filter((p) => !!p.challenge).length;
  const blankPages = pages.filter((p) => p.blankContent).length;

  // 降级判定有两路来源，二者独立成立：
  //  - 后端显式声明 fallback（整批换后端 / 部分页面换后端）；
  //  - provider 与 requested_mode 不一致（例如设置里选了浏览器却由裸抓服务）。
  // requested_mode 是后加的字段，旧数据缺失时只依赖显式 fallback，不会误报降级。
  const degraded = !!fallback || (!!provider && !!requestedMode && provider !== requestedMode);

  return {
    provider,
    requestedMode,
    fallback,
    interception: readInterception(meta.interception),
    pages,
    blockedPages,
    blankPages,
    degraded,
  };
}

/**
 * 读取联网工具的状态；非联网工具或没有可用信号时返回 `null`。
 */
export function readWebToolStatus(
  toolName: string,
  metadata?: Record<string, unknown>,
): WebToolStatus | null {
  if (!isWebTool(toolName)) return null;
  const status = readStatus(metadata);
  const hasSignal =
    !!status.provider ||
    !!status.requestedMode ||
    !!status.fallback ||
    !!status.interception ||
    status.pages.length > 0;
  return hasSignal ? status : null;
}

export type ChipTone = 'neutral' | 'warning' | 'danger';

export interface StatusChip {
  key: string;
  label: string;
  tone: ChipTone;
  /** hover 提示：说明原因，不占版面。 */
  title?: string;
}

/**
 * 卡片标题行右侧的状态小标记。
 *
 * 之所以放在标题行（而不是只在展开区）：仓库既有惯例就是在这里显示「已阻止 /
 * 已中断 / 超时」，用户不展开也能看到本次调用出了什么问题。折叠成「已探索 N 次
 * 读取」时，这些标记由 `summarizeWebToolGroup` 汇总到分组标题上。
 */
export function webToolChips(status: WebToolStatus): StatusChip[] {
  const chips: StatusChip[] = [];

  if (status.provider) {
    chips.push({
      key: 'provider',
      label: backendLabel(status.provider),
      tone: 'neutral',
      title: status.requestedMode && status.requestedMode !== status.provider
        ? `设置要求：${backendLabel(status.requestedMode)}；实际使用：${backendLabel(status.provider)}`
        : `本次后端：${backendLabel(status.provider)}`,
    });
  }

  if (status.fallback) {
    chips.push({
      key: 'fallback',
      label: '已降级',
      tone: 'warning',
      title: `${backendLabel(status.fallback.from)}失败，已改用${backendLabel(status.fallback.to)}${status.fallback.reason ? `：${status.fallback.reason}` : ''}`,
    });
  } else if (status.degraded) {
    chips.push({
      key: 'degraded',
      label: '已降级',
      tone: 'warning',
      title: `设置要求：${backendLabel(status.requestedMode)}；实际使用：${backendLabel(status.provider)}`,
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
 * 展开区里的一段说明，解释「本次到底发生了什么」。
 * 没有异常时返回 `null`，不占用版面。
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

  if (status.fallback) {
    return {
      tone: 'warning',
      title: `已降级为${backendLabel(status.fallback.to)}`,
      lines: [
        `${backendLabel(status.fallback.from)}本次没有成功，已自动改用${backendLabel(status.fallback.to)}。内容质量可能低于预期。`,
        status.fallback.reason ? `原因：${status.fallback.reason}` : '',
      ].filter(Boolean),
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
