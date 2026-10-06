import { describe, expect, it, vi } from 'vitest';

// 平台判定要能按用例切换：本文件跑在 node 环境（无 window/localStorage），
// 真实提示推断不出手机端，只能替换掉 `@/platform` 的这两个入口。
const platform = vi.hoisted(() => ({ mobile: false }));
vi.mock('@/platform', () => ({
  collectPlatformHints: () => ({}),
  isMobilePlatform: () => platform.mobile,
}));

import {
  backendLabel,
  formatPageStatus,
  isWebTool,
  readWebToolStatus,
  summarizeWebToolGroup,
  webToolChips,
  webToolDetails,
  webToolNotice,
} from './webToolStatus';

describe('isWebTool', () => {
  it('only treats the two networked tools as web tools', () => {
    expect(isWebTool('web_search')).toBe(true);
    expect(isWebTool('http_get')).toBe(true);
    expect(isWebTool('bash')).toBe(false);
    expect(isWebTool('read_file')).toBe(false);
  });
});

describe('backendLabel', () => {
  it('maps known backends to Chinese labels', () => {
    expect(backendLabel('browser')).toBe('本机浏览器');
    expect(backendLabel('html')).toBe('裸抓 HTML');
    expect(backendLabel('api:brave')).toBe('Brave 搜索 API');
    expect(backendLabel('api:tavily')).toBe('Tavily 搜索 API');
  });

  it('passes unknown backends through rather than showing nothing', () => {
    expect(backendLabel('some-future-backend')).toBe('some-future-backend');
    expect(backendLabel(undefined)).toBe('');
  });
});

describe('readWebToolStatus', () => {
  it('ignores tools that have no backend semantics', () => {
    expect(readWebToolStatus('bash', { provider: 'browser' })).toBeNull();
  });

  it('returns null for legacy results that carry no signals at all', () => {
    // 旧会话回放：没有任何新字段 → 不显示任何提示，界面保持原样。
    expect(readWebToolStatus('web_search', undefined)).toBeNull();
    expect(readWebToolStatus('web_search', {})).toBeNull();
    expect(readWebToolStatus('http_get', { urls_fetched: 2 })).toBeNull();
  });

  it('reads a plain successful search', () => {
    const status = readWebToolStatus('web_search', {
      provider: 'browser',
      requested_mode: 'browser',
      total_results: 3,
    });
    expect(status).not.toBeNull();
    expect(status?.provider).toBe('browser');
    expect(status?.degraded).toBe(false);
    expect(webToolNotice(status!)).toBeNull();
  });

  it('marks a recovered fallback once without warning about content quality', () => {
    const status = readWebToolStatus('web_search', {
      provider: 'html',
      requested_mode: 'browser',
      fallback: { from: 'browser', to: 'html', reason: 'browser boot: CDP endpoint did not become ready within 12s' },
    })!;

    expect(status.degraded).toBe(true);
    const chips = webToolChips(status);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ label: '已切换方式', tone: 'neutral' });
    expect(webToolNotice(status)).toBeNull();
  });

  it('detects a degradation from provider/requested_mode mismatch alone', () => {
    // 后端未显式声明 fallback，但两者不一致时也必须提示，不能假装正常。
    const status = readWebToolStatus('http_get', {
      provider: 'html',
      requested_mode: 'browser',
    })!;
    expect(status.degraded).toBe(true);
    expect(webToolChips(status).map((c) => c.label)).toContain('已切换方式');
  });

  it('treats the browser→html rewrite as unavailable, not degraded, on mobile', () => {
    // 手机端没有本机浏览器可走 CDP，后端把设置里的 browser 落到裸抓上；而手机上
    // 根本选不到「本机浏览器」，Android 全新安装的默认值又正好是 browser。把它报成
    // 降级，等于每次搜索都让用户去改一个他改不了的设置。
    platform.mobile = true;
    try {
      const status = readWebToolStatus('web_search', {
        provider: 'html',
        requested_mode: 'browser',
      })!;
      expect(status.degraded).toBe(false);
      expect(webToolChips(status).map((c) => c.label)).not.toContain('已降级');
      expect(webToolNotice(status)).toBeNull();
    } finally {
      platform.mobile = false;
    }
  });

  it('still reports a real browser fallback on mobile', () => {
    // 平台提供不了的归平台，真正的降级由显式 fallback 负责，不受上面那条影响。
    platform.mobile = true;
    try {
      const status = readWebToolStatus('web_search', {
        provider: 'html',
        requested_mode: 'browser',
        fallback: { from: 'browser', to: 'html', reason: 'browser boot: timed out' },
      })!;
      expect(status.degraded).toBe(true);
      expect(webToolChips(status).map((c) => c.label)).toContain('已切换方式');
    } finally {
      platform.mobile = false;
    }
  });

  it('keeps browser→html a degradation on desktop, where that mode is available', () => {
    platform.mobile = false;
    const status = readWebToolStatus('web_search', {
      provider: 'html',
      requested_mode: 'browser',
    })!;
    expect(status.degraded).toBe(true);
  });

  it('does not report degradation for legacy data missing requested_mode', () => {
    const status = readWebToolStatus('http_get', { provider: 'browser' })!;
    expect(status.degraded).toBe(false);
    expect(webToolChips(status).map((c) => c.label)).not.toContain('已降级');
  });

  it('surfaces a search interception with the vendor', () => {
    const status = readWebToolStatus('web_search', {
      provider: 'browser',
      requested_mode: 'browser',
      interception: { kind: 'challenge', vendor: '百度安全验证' },
    })!;

    expect(webToolChips(status).map((c) => c.label)).toContain('被网站拦截');
    const notice = webToolNotice(status)!;
    expect(notice.lines.join(' ')).toContain('百度安全验证');
    expect(notice.lines.join(' ')).toContain('联网搜索方式');
  });

  it('surfaces a not-a-results-page interception', () => {
    const status = readWebToolStatus('web_search', {
      provider: 'html',
      interception: { kind: 'not-a-results-page', detail: 'title="Oops" bytes=12' },
    })!;
    const notice = webToolNotice(status)!;
    expect(notice.title).toBe('搜索被网站拦截');
    expect(notice.lines.join(' ')).toContain('title="Oops"');
  });

  it('counts blocked pages for batch http_get', () => {
    const status = readWebToolStatus('http_get', {
      provider: 'browser',
      requested_mode: 'browser',
      pages: [
        { url: 'https://ok.example/', status: 200, http_error: false, blank_content: false },
        { url: 'https://blocked.example/', status: null, challenge: '百度安全验证', http_error: false, blank_content: false },
      ],
    })!;

    expect(status.blockedPages).toBe(1);
    expect(webToolChips(status).map((c) => c.label)).toContain('1 个页面被网站拦截');
    const notice = webToolNotice(status)!;
    expect(notice.lines.join(' ')).toContain('https://blocked.example/');
    expect(notice.lines.join(' ')).toContain('百度安全验证');
  });

  it('never invents a status code for a browser page with no HTTP response', () => {
    const status = readWebToolStatus('http_get', {
      provider: 'browser',
      pages: [{ url: 'https://x.example/', status: null, blank_content: true, http_error: false }],
    })!;
    expect(status.pages[0].status).toBeNull();
    expect(formatPageStatus(status.pages[0])).toBe('状态未知（无 HTTP 响应）');
  });

  it('flags a batch in which every page converted to nothing', () => {
    const status = readWebToolStatus('http_get', {
      provider: 'browser',
      pages: [
        { url: 'https://a.example/', status: 200, blank_content: true, http_error: false },
        { url: 'https://b.example/', status: 200, blank_content: true, http_error: false },
      ],
    })!;
    expect(status.blankPages).toBe(2);
    expect(webToolNotice(status)?.title).toBe('页面没有可读内容');
  });

  it('does not claim blank content for legacy page entries missing the field', () => {
    const status = readWebToolStatus('http_get', {
      provider: 'html',
      pages: [{ url: 'https://a.example/', status: 200, http_error: false }],
    })!;
    expect(status.blankPages).toBe(0);
    expect(webToolNotice(status)).toBeNull();
  });

  it('survives malformed metadata instead of throwing', () => {
    const status = readWebToolStatus('http_get', {
      provider: 42,
      requested_mode: null,
      fallback: 'nope',
      interception: { kind: 'unknown-kind' },
      pages: ['not-an-object', null, { url: 7 }],
    });
    // 有害数据被丢弃，但没有可识别信号 → 当作无状态处理，界面不炸。
    expect(status).toBeNull();
  });

  it('keeps usable fields from partially malformed metadata', () => {
    const status = readWebToolStatus('web_search', {
      provider: 'browser',
      fallback: { from: 'browser' }, // to 缺失 → 整条 fallback 丢弃
      interception: { kind: 'challenge', vendor: 'Cloudflare' },
    })!;
    expect(status.fallback).toBeUndefined();
    expect(status.degraded).toBe(false);
    expect(status.interception?.vendor).toBe('Cloudflare');
  });
});

describe('fetch provider compatibility', () => {
  it('honors an explicit non-degraded download transfer despite a provider mismatch', () => {
    const status = readWebToolStatus('http_get', {
      provider: 'html', requested_mode: 'browser', degraded: false,
    })!;
    expect(status.degraded).toBe(false);
    expect(webToolChips(status)).toMatchObject([{ label: '裸抓 HTML', tone: 'neutral' }]);
    expect(webToolNotice(status)).toBeNull();
  });

  it('infers mixed providers from complete legacy page records', () => {
    const status = readWebToolStatus('http_get', {
      provider: 'html', requested_mode: 'browser',
      pages: [
        { url: 'https://rendered.example/', provider: 'browser', status: 200 },
        { url: 'https://fallback.example/', provider: 'html', status: 200 },
      ],
    })!;
    expect(status.provider).toBe('mixed');
    expect(webToolChips(status)).toMatchObject([{ label: '部分已切换', tone: 'neutral' }]);
  });

  it('preserves the declared provider when old page records are incomplete', () => {
    for (const extra of [{ url: 'https://legacy.example/' }, null]) {
      const status = readWebToolStatus('http_get', {
        provider: 'html', requested_mode: 'browser',
        pages: [
          { url: 'https://rendered.example/', provider: 'browser' },
          { url: 'https://fallback.example/', provider: 'html' },
          extra,
        ],
      })!;
      expect(status.provider).toBe('html');
    }
  });

  it('ignores malformed degraded values instead of suppressing a real fallback', () => {
    const status = readWebToolStatus('http_get', {
      provider: 'html', requested_mode: 'browser', degraded: 'false',
    })!;
    expect(status.degraded).toBe(true);
  });

  it('retains an explicit fallback even if corrupt metadata also claims no degradation', () => {
    const status = readWebToolStatus('http_get', {
      provider: 'html', degraded: false,
      fallback: { from: 'browser', to: 'html', reason: 'navigation timed out' },
    })!;
    expect(status.degraded).toBe(true);
    expect(webToolDetails(status).join(' ')).toContain('navigation timed out');
  });

  it('shows the actual per-page providers in optional mixed-fetch details', () => {
    const status = readWebToolStatus('http_get', {
      provider: 'mixed', requested_mode: 'browser', degraded: true,
      fallback: { from: 'browser', to: 'html', reason: 'one page timed out' },
      pages: [
        { url: 'https://rendered.example/', provider: 'browser', status: 200 },
        { url: 'https://fallback.example/', provider: 'html', status: 200 },
      ],
    })!;
    expect(webToolDetails(status)).toContain('https://rendered.example/ — 本机浏览器');
    expect(webToolDetails(status)).toContain('https://fallback.example/ — 裸抓 HTML');
    expect(webToolDetails(status)).toContain('原因：one page timed out');
  });

  it('keeps a fallback from hiding an unreadable or intercepted final page', () => {
    const meta = {
      provider: 'html', requested_mode: 'browser',
      fallback: { from: 'browser', to: 'html', reason: 'navigation timed out' },
    };
    const blocked = readWebToolStatus('http_get', {
      ...meta, pages: [{ url: 'https://blocked.example/', challenge: 'Cloudflare' }],
    })!;
    expect(webToolNotice(blocked)?.title).toBe('1 个页面被网站拦截');
    const blank = readWebToolStatus('http_get', {
      ...meta, pages: [{ url: 'https://blank.example/', blank_content: true }],
    })!;
    expect(webToolNotice(blank)?.title).toBe('页面没有可读内容');
  });
});

describe('webToolChips', () => {
  it('reports a partially failed batch instead of claiming the failed request recovered', () => {
    const status = readWebToolStatus('http_get', {
      provider: 'browser', requested_mode: 'browser', failed: 1, success: 1, urls_fetched: 2,
      fallback: { from: 'browser', to: 'html', reason: 'both requests failed' },
    })!;
    expect(webToolChips(status)).toMatchObject([{ label: '部分获取失败', tone: 'warning' }]);
    expect(webToolChips(status)).toHaveLength(1);
    expect(webToolDetails(status).join(' ')).toContain('已尝试');
  });

  it('reports a fully failed fetch from final failure counts', () => {
    for (const toolName of ['http_get', 'web_search']) {
      const status = readWebToolStatus(toolName, { failed: 1, success: 0 })!;
      expect(webToolChips(status)).toMatchObject([{ label: '获取失败', tone: 'warning' }]);
    }
  });

  it('does not invent failure from missing or malformed counts', () => {
    for (const failed of [undefined, -1, 1.5, '1', Infinity, NaN]) {
      const status = readWebToolStatus('http_get', { provider: 'html', failed, success: 0 })!;
      expect(webToolChips(status)).toMatchObject([{ label: '裸抓 HTML', tone: 'neutral' }]);
    }
    const recovered = readWebToolStatus('http_get', {
      provider: 'html', failed: 0, success: 1,
      fallback: { from: 'browser', to: 'html', reason: 'browser timed out' },
    })!;
    expect(webToolChips(recovered)).toMatchObject([{ label: '已切换方式', tone: 'neutral' }]);
  });

  it('does not repeat a failure chip beside an explicit website interception', () => {
    const status = readWebToolStatus('web_search', {
      provider: 'html', failed: 1, success: 0,
      fallback: { from: 'browser', to: 'html', reason: 'browser timed out' },
      interception: { kind: 'challenge', vendor: 'Cloudflare' },
    })!;
    const labels = webToolChips(status).map((chip) => chip.label);
    expect(labels).toContain('被网站拦截');
    expect(labels).not.toContain('获取失败');
    expect(labels).not.toContain('已切换方式');
  });

  it('always exposes which backend ran, so results are never ambiguous', () => {
    const status = readWebToolStatus('http_get', {
      provider: 'html',
      requested_mode: 'html',
    })!;
    const chips = webToolChips(status);
    expect(chips).toHaveLength(1);
    expect(chips[0].label).toBe('裸抓 HTML');
    expect(chips[0].tone).toBe('neutral');
  });

  it('keeps an interception visible without suggesting the fallback recovered it', () => {
    const status = readWebToolStatus('web_search', {
      provider: 'html',
      requested_mode: 'browser',
      fallback: { from: 'browser', to: 'html', reason: 'boot timed out' },
      interception: { kind: 'challenge', vendor: '百度安全验证' },
    })!;
    const labels = webToolChips(status).map((c) => c.label);
    expect(labels).toEqual(['裸抓 HTML', '被网站拦截']);
  });
});

describe('summarizeWebToolGroup', () => {
  it('reports zero when every call in the group was clean', () => {
    const summary = summarizeWebToolGroup([
      { toolName: 'web_search', metadata: { provider: 'browser', requested_mode: 'browser' } },
      { toolName: 'http_get', metadata: { provider: 'browser', requested_mode: 'browser' } },
    ]);
    expect(summary).toEqual({ degraded: 0, blocked: 0 });
  });

  it('counts degraded and blocked calls so a collapsed group still warns', () => {
    const summary = summarizeWebToolGroup([
      { toolName: 'web_search', metadata: { provider: 'browser', requested_mode: 'browser' } },
      {
        toolName: 'web_search',
        metadata: {
          provider: 'html',
          requested_mode: 'browser',
          fallback: { from: 'browser', to: 'html', reason: 'boot timed out' },
        },
      },
      {
        toolName: 'http_get',
        metadata: {
          provider: 'browser',
          requested_mode: 'browser',
          pages: [{ url: 'https://x.example/', status: null, challenge: 'Cloudflare' }],
        },
      },
    ]);
    expect(summary).toEqual({ degraded: 1, blocked: 1 });
  });

  it('ignores non-web tools and legacy messages', () => {
    const summary = summarizeWebToolGroup([
      { toolName: 'read_file', metadata: { provider: 'browser' } },
      { toolName: 'web_search' },
    ]);
    expect(summary).toEqual({ degraded: 0, blocked: 0 });
  });
});
