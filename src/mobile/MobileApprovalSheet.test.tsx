// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import MobileApprovalSheet from './MobileApprovalSheet';
import type { ToolCallInfo } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 不实现 ResizeObserver，而 MobileSheet 用它测拖拽高度 —— 补个空壳即可，
// 这里断言的是按钮行为，不涉及尺寸。
(globalThis as Record<string, unknown>).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const TOOL_CALL: ToolCallInfo = {
  id: 'call-1',
  name: 'bash',
  arguments: { command: 'rm -rf /srv/prod' },
  disposition: 'ForceApproval',
};

let container: HTMLDivElement;
let root: Root;
let onApprove: ReturnType<typeof vi.fn>;
let onReject: ReturnType<typeof vi.fn>;
let onRejectAndStop: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onApprove = vi.fn();
  onReject = vi.fn();
  onRejectAndStop = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  // MobileSheet 用 createPortal 挂到 body 上，卸载后把残留容器一起清掉，
  // 免得下一条用例查到上一条的 DOM。
  document.body.innerHTML = '';
});

function render(
  withRejectAndStop = true,
  toolCall: ToolCallInfo = TOOL_CALL,
) {
  act(() => {
    root.render(
      <MobileApprovalSheet
        toolCall={toolCall}
        open={true}
        onApprove={onApprove}
        onReject={onReject}
        onRejectAndStop={withRejectAndStop ? onRejectAndStop : undefined}
      />,
    );
  });
}

function byLabel(label: string): HTMLButtonElement {
  const el = Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!el) throw new Error(`找不到按钮：${label}`);
  return el;
}

function typeReason(text: string) {
  const input = document.body.querySelector<HTMLInputElement>('input[aria-label="拒绝原因"]');
  if (!input) throw new Error('找不到拒绝原因输入框');
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * 移动端与桌面端必须给出同一套能力（AGENTS.md 的双端对齐要求）。
 * 这里只钉最容易漏的那两条：理由真的送出去了、以及「拒绝并停止」确实是两件事。
 */
describe('MobileApprovalSheet 的拒绝理由', () => {
  it('填了理由后点「拒绝」，理由跟着一起送出去', () => {
    render();
    typeReason('这是生产库，别动');
    act(() => byLabel('拒绝').click());

    expect(onReject).toHaveBeenCalledWith('这是生产库，别动');
  });

  it('没填理由时拒绝照常，只是不带理由', () => {
    render();
    act(() => byLabel('拒绝').click());

    expect(onReject).toHaveBeenCalledWith(undefined);
  });

  it('「拒绝并停止任务」走另一条路，不算普通拒绝', () => {
    render();
    typeReason('整条思路都不对');
    act(() => byLabel('拒绝并停止任务').click());

    expect(onRejectAndStop).toHaveBeenCalledWith('整条思路都不对');
    expect(onReject).not.toHaveBeenCalled();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('调用方没提供该能力时，按钮不出现', () => {
    render(false);
    const labels = Array.from(document.body.querySelectorAll('button')).map((b) =>
      b.textContent?.trim(),
    );
    // 先证明面板真的渲染出来了，再断言按钮不在 —— 否则查询落空时这条会假通过。
    expect(labels).toContain('拒绝');
    expect(labels).toContain('批准');
    expect(labels).not.toContain('拒绝并停止任务');
  });

  /// 与桌面端同一根因：队首前进时是同一个组件实例，理由必须跟着 `toolCall.id` 清空，
  /// 否则给上一条写的理由会原样发给下一条。
  it('队首换成下一条后，理由输入框被清空', () => {
    render();
    typeReason('只针对这条');
    act(() => {
      root.render(
        <MobileApprovalSheet
          toolCall={{ ...TOOL_CALL, id: 'call-2' }}
          open={true}
          onApprove={onApprove}
          onReject={onReject}
          onRejectAndStop={onRejectAndStop}
        />,
      );
    });

    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="拒绝原因"]')!;
    expect(input.value).toBe('');
    act(() => byLabel('拒绝').click());
    expect(onReject).toHaveBeenCalledWith(undefined);
  });
});

/**
 * 命令说明（bash 的必填 description）—— 与桌面端 ApprovalDialog 对称断言。
 * 双端共用 `cleanExecuteCommandArgs`，但渲染是各写一份，所以两边都要钉。
 */
describe('Agent 说明（移动端）', () => {
  const withDescription = (description: unknown): ToolCallInfo => ({
    ...TOOL_CALL,
    arguments: { command: 'rm -rf /srv/prod', description },
  });

  it('有说明时显示，并排在命令前面', () => {
    render(true, withDescription('清理生产环境的旧构建产物'));

    const text = document.body.textContent ?? '';
    expect(text).toContain('Agent 说明');
    expect(text).toContain('清理生产环境的旧构建产物');
    expect(text.indexOf('Agent 说明')).toBeLessThan(
      text.indexOf('rm -rf /srv/prod'),
    );
  });

  it('说明不再重复出现在参数 JSON 里', () => {
    render(true, withDescription('清理生产环境的旧构建产物'));
    const occurrences =
      (document.body.textContent ?? '').split('清理生产环境的旧构建产物').length - 1;
    expect(occurrences).toBe(1);
  });

  it('没有说明时不显示这一行', () => {
    render();
    expect(document.body.textContent ?? '').not.toContain('Agent 说明');
  });

  it('空白说明等同于没有', () => {
    render(true, withDescription('  '));
    expect(document.body.textContent ?? '').not.toContain('Agent 说明');
  });
});
