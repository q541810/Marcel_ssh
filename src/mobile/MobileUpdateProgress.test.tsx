import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UpdateState } from '@/lib/types';

// vi.hoisted：mock 工厂在 import 之前执行，直接引用外层 let 会撞 TDZ。
const mock = vi.hoisted(() => ({
  state: { status: 'idle' } as UpdateState,
}));

vi.mock('@/stores/updateStore', () => ({
  useUpdateStore: (selector: (s: { state: UpdateState }) => unknown) =>
    selector({ state: mock.state }),
}));

import MobileUpdateProgress from './MobileUpdateProgress';

/**
 * 移动端下载进度指示的渲染契约。
 *
 * 之所以要专门锁这个：它只在「下载中」这一小段时间存在（默认几十秒），
 * 事后完全看不到 —— 出问题也只能靠测试发现，不能靠肉眼。
 */
describe('MobileUpdateProgress', () => {
  it('非下载态不渲染任何东西（idle / 仅提示 / 就绪 / 失败）', () => {
    const states: UpdateState[] = [
      { status: 'idle' },
      { status: 'available', version: '1.4.1', releaseUrl: 'https://example.com' },
      { status: 'ready', version: '1.4.1' },
      { status: 'failed', message: '磁盘空间不足' },
    ];
    for (const state of states) {
      mock.state = state;
      expect(renderToStaticMarkup(<MobileUpdateProgress />)).toBe('');
    }
  });

  it('下载中：渲染进度条 + 版本 + 百分比（半程）', () => {
    mock.state = {
      status: 'downloading',
      version: '1.4.1',
      downloaded: 15 * 1024 * 1024,
      total: 30 * 1024 * 1024,
    };
    const html = renderToStaticMarkup(<MobileUpdateProgress />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('width:50%');
    expect(html).toContain('正在下载 1.4.1 · 50%');
  });

  it('total 未知（后端还没拿到 Content-Length）时按 0% 显示，不出现 NaN', () => {
    mock.state = {
      status: 'downloading',
      version: '1.4.1',
      downloaded: 4096,
      total: 0,
    };
    const html = renderToStaticMarkup(<MobileUpdateProgress />);
    expect(html).not.toContain('NaN');
    expect(html).toContain('aria-valuenow="0"');
  });

  it('收到超过 total 的字节时封顶 100%，不溢出容器宽度', () => {
    mock.state = {
      status: 'downloading',
      version: '1.4.1',
      downloaded: 40 * 1024 * 1024,
      total: 30 * 1024 * 1024,
    };
    expect(renderToStaticMarkup(<MobileUpdateProgress />)).toContain('width:100%');
  });

  it('不拦截点击（下载中也要能操作界面）', () => {
    mock.state = {
      status: 'downloading',
      version: '1.4.1',
      downloaded: 1,
      total: 2,
    };
    expect(renderToStaticMarkup(<MobileUpdateProgress />)).toContain(
      'pointer-events-none',
    );
  });
});
