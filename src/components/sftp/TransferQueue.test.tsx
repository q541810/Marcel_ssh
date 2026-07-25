import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// TransferQueue 顶层 import 了 scheduler → sessionStore → xterm（node 环境 self 未定义）。
// 纯视图不需要真实 scheduler，mock 掉以切断该 import 链。
vi.mock('@/stores/transferScheduler', () => ({
  cancelTransfer: vi.fn(),
}));

import { TransferCenterView } from '@/components/sftp/TransferQueue';
import type { StoredTransferItem, TransferItem } from '@/stores/transferStore';

let seq = 0;
function item(patch: Partial<StoredTransferItem> = {}): StoredTransferItem {
  seq += 1;
  const base: TransferItem = {
    id: `t-${seq}`,
    kind: 'upload',
    sessionId: 's1',
    fileName: `file-${seq}.txt`,
    localPath: `C:/tmp/file-${seq}.txt`,
    remotePath: `/srv/file-${seq}.txt`,
    written: 0,
    total: 100,
    statusText: '排队中',
    createdAt: seq,
  };
  return { ...base, status: 'queued', ...patch };
}

function render(list: StoredTransferItem[]) {
  return renderToStaticMarkup(
    <TransferCenterView
      list={list}
      onClose={() => {}}
      onClear={() => {}}
      onCancel={() => {}}
      onRemove={() => {}}
    />,
  );
}

describe('TransferCenterView', () => {
  it('shows empty state when no transfers exist', () => {
    const html = render([]);
    expect(html).toContain('传输中心');
    expect(html).toContain('暂无传输任务');
    expect(html).not.toContain('清除已完成');
  });

  it('renders queued and active rows with cancel buttons', () => {
    const html = render([
      item({ fileName: 'a.txt', status: 'active', written: 50, statusText: '上传 50%' }),
      item({ fileName: 'b.txt', status: 'queued' }),
    ]);
    expect(html).toContain('a.txt');
    expect(html).toContain('上传 50%');
    expect(html).toContain('b.txt');
    expect(html).toContain('排队中');
    expect((html.match(/>取消<\/button>/g) ?? []).length).toBe(2);
  });

  it('hides cancel for folder-upload in extracting phase', () => {
    const html = render([
      item({
        kind: 'folder-upload',
        fileName: 'dir',
        status: 'active',
        phase: 'extracting',
        statusText: '正在远端解压，暂不可取消 90%',
      }),
    ]);
    expect(html).toContain('正在远端解压，暂不可取消 90%');
    expect(html).not.toContain('>取消</button>');
  });

  it('shows clear-finished button and remove control for finished items', () => {
    const html = render([
      item({ fileName: 'done.txt', status: 'done', statusText: 'done.txt 上传完成' }),
    ]);
    expect(html).toContain('清除已完成');
    expect(html).toContain('title="移除记录"');
    expect(html).not.toContain('>取消</button>');
  });

  it('renders a progress bar only for active transfers with known total', () => {
    const html = render([
      item({ status: 'active', written: 30, total: 100 }),
    ]);
    expect(html).toContain('width:30%');
  });
});
