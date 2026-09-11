import { describe, expect, it } from 'vitest';
import {
  backendLabel,
  formatPageStatus,
  isWebTool,
  readWebToolStatus,
  summarizeWebToolGroup,
  webToolChips,
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

  it('treats an explicit fallback as degraded and explains it', () => {
    const status = readWebToolStatus('web_search', {
      provider: 'html',
      requested_mode: 'browser',
      fallback: { from: 'browser', to: 'html', reason: 'browser boot: CDP endpoint did not become ready within 12s' },
    })!;

    expect(status.degraded).toBe(true);
    const chips = webToolChips(status);
    expect(chips.map((c) => c.label)).toContain('已降级');

    const notice = webToolNotice(status)!;
    expect(notice.title).toBe('已降级为裸抓 HTML');
    expect(notice.lines.join(' ')).toContain('CDP endpoint did not become ready');
  });

  it('detects a degradation from provider/requested_mode mismatch alone', () => {
    // 后端未显式声明 fallback，但两者不一致时也必须提示，不能假装正常。
    const status = readWebToolStatus('http_get', {
      provider: 'html',
      requested_mode: 'browser',
    })!;
    expect(status.degraded).toBe(true);
    expect(webToolChips(status).map((c) => c.label)).toContain('已降级');
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

describe('webToolChips', () => {
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

  it('orders a degradation before an interception', () => {
    const status = readWebToolStatus('web_search', {
      provider: 'html',
      requested_mode: 'browser',
      fallback: { from: 'browser', to: 'html', reason: 'boot timed out' },
      interception: { kind: 'challenge', vendor: '百度安全验证' },
    })!;
    const labels = webToolChips(status).map((c) => c.label);
    expect(labels.indexOf('已降级')).toBeLessThan(labels.indexOf('被网站拦截'));
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
