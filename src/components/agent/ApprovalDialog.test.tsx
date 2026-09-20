// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ApprovalDialog from './ApprovalDialog';
import type { ToolCallInfo } from '@/lib/types';

// 让 react act() 在 jsdom 下正常工作
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TOOL_CALL: ToolCallInfo = {
  id: 'call-1',
  name: 'bash',
  arguments: { command: 'systemctl restart nginx' },
  disposition: 'ForceApproval',
};

let container: HTMLDivElement;
let root: Root;
let onApprove: ReturnType<typeof vi.fn>;
let onReject: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;
let onMinimize: ReturnType<typeof vi.fn>;
let onRejectAndStop: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onApprove = vi.fn();
  onReject = vi.fn();
  onClose = vi.fn();
  onMinimize = vi.fn();
  onRejectAndStop = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(withMinimize = true, withRejectAndStop = true) {
  act(() => {
    root.render(
      <ApprovalDialog
        toolCall={TOOL_CALL}
        onApprove={onApprove}
        onReject={onReject}
        open={true}
        onClose={onClose}
        onMinimize={withMinimize ? onMinimize : undefined}
        onRejectAndStop={withRejectAndStop ? onRejectAndStop : undefined}
      />,
    );
  });
}

function backdrop(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.modal-backdrop-enter');
  if (!el) throw new Error('找不到背景遮罩');
  return el;
}

function button(label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!el) throw new Error(`找不到按钮：${label}`);
  return el;
}

/**
 * 派发一次键盘事件，并把时钟推过 300ms 的"队首切换冷却"。
 *
 * 不推时钟的话，全局 Enter 处理会在冷却里直接 return —— 于是"输入框里按 Enter
 * 不该批准"这条测试会因为**冷却**而通过，而不是因为输入框保护生效，
 * 去掉保护也照样绿（第一版正是这么写的假护栏）。
 */
function pressKey(key: string, target: EventTarget = document) {
  const realNow = Date.now;
  Date.now = () => realNow() + 1000;
  try {
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  } finally {
    Date.now = realNow;
  }
}

function pressEscape() {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

/** 往拒绝理由输入框里打字（React 受控 input：走原生 setter 再派发 input 事件）。 */
function typeReason(text: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="拒绝原因"]');
  if (!input) throw new Error('找不到拒绝原因输入框');
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
}

/**
 * 这一组盯的是一件事：**误触不能替用户做决定。**
 *
 * 审批的「拒绝」是不可逆的 —— 模型收到「用户拒绝」就换方案走了，用户甚至没意识到
 * 自己做了一个决定。所以点背景、按 Esc 这类"顺手"的动作只能把弹窗收起来（右下角
 * 浮动药丸，随时点得回来），答案必须来自显式按钮。
 *
 * 这三条曾经全接到 `onClose`，而调用方把它映射成了 `reject`。
 */
describe('ApprovalDialog 的误触防护', () => {
  it('点背景只收起，不拒绝', () => {
    render();
    act(() => backdrop().click());

    expect(onMinimize).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('按 Esc 只收起，不拒绝', () => {
    render();
    pressEscape();

    expect(onMinimize).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('没有收起出口时退回 onClose，也不拒绝', () => {
    render(false);
    act(() => backdrop().click());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
  });

  it('标题栏不再有含义不明的 ✕ —— 只有明确的两个答案 + 收起', () => {
    render();
    const labels = Array.from(container.querySelectorAll('button')).map((b) =>
      b.textContent?.trim(),
    );
    expect(labels).toContain('拒绝');
    expect(labels).toContain('批准');
    expect(labels).not.toContain('×');
  });
});

/** 显式动作照旧生效 —— 上面的豁免不能把正常路径一起关掉。 */
describe('ApprovalDialog 的显式回答', () => {
  it('点「拒绝」才拒绝', () => {
    render();
    act(() => button('拒绝').click());

    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onMinimize).not.toHaveBeenCalled();
  });

  it('点「批准」才批准', () => {
    render();
    act(() => button('批准').click());

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onMinimize).not.toHaveBeenCalled();
  });

  it('点「收起」按钮只收起', () => {
    render();
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="收起"]')!.click();
    });

    expect(onMinimize).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
  });
});

/** 拒绝理由：模型唯一能看到的「为什么不让我做」。 */
describe('拒绝理由', () => {
  it('填了理由后点「拒绝」，理由跟着一起送出去', () => {
    render();
    typeReason('这台机器上不许动 nginx 配置');
    act(() => button('拒绝').click());

    expect(onReject).toHaveBeenCalledWith('这台机器上不许动 nginx 配置');
  });

  it('没填理由时拒绝照常，只是不带理由', () => {
    render();
    act(() => button('拒绝').click());

    expect(onReject).toHaveBeenCalledWith(undefined);
  });

  /// **最容易出事的一条**：用户打完理由顺手回车。
  /// 如果不把输入框里的键盘事件排除掉，全局的 Enter = 批准会先生效 ——
  /// 用户想拒绝，结果批准了。
  it('在理由输入框里按 Enter 是拒绝，绝不是批准', () => {
    render();
    const input = typeReason('别动生产库');
    pressKey('Enter', input);

    expect(onApprove).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith('别动生产库');
  });

  /// 反面：焦点不在输入框时，Enter 仍然是「批准」——上面的保护不能把正常路径关掉。
  it('焦点不在输入框时，Enter 还是批准', () => {
    render();
    pressKey('Enter');

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
  });

  it('只有空白的理由等于没填', () => {
    render();
    typeReason('   ');
    act(() => button('拒绝').click());

    expect(onReject).toHaveBeenCalledWith(undefined);
  });
});

/**
 * 键盘护栏只管**弹窗自己的**理由输入框。
 *
 * 监听器挂在 `document` 上：以前放行条件是「任意 INPUT/TEXTAREA 有焦点」，于是
 * 用户刚在面板输入框打完字、弹窗一到，Enter 和 Esc 就一起失效 —— 而弹窗还在
 * 提示那两个键能用。
 */
describe('键盘护栏只管自己的输入框', () => {
  it('焦点在弹窗以外的输入框时，Enter 仍是批准', () => {
    render();
    const foreign = document.createElement('input');
    document.body.appendChild(foreign);
    try {
      foreign.focus();
      pressKey('Enter', foreign);
      expect(onApprove).toHaveBeenCalledTimes(1);
      expect(onReject).not.toHaveBeenCalled();
    } finally {
      foreign.remove();
    }
  });

  it('焦点在弹窗以外的输入框时，Esc 仍是收起', () => {
    render();
    const foreign = document.createElement('input');
    document.body.appendChild(foreign);
    try {
      foreign.focus();
      pressKey('Escape', foreign);
      expect(onMinimize).toHaveBeenCalledTimes(1);
    } finally {
      foreign.remove();
    }
  });

  it('理由输入框里的 Esc 也是收起（与弹窗其他位置一致）', () => {
    render();
    const input = typeReason('x');
    pressKey('Escape', input);
    expect(onMinimize).toHaveBeenCalledTimes(1);
  });
});

/**
 * 队首前进时，上一条的理由不能带进下一条 —— 它是给「那条命令」的。
 *
 * 以前 `reason` 没有像 `mountedAtRef` 那样跟着 `toolCall.id` 重置，于是给 A 写的
 * 理由会原样发给 B（队列前进时是同一个组件实例）。
 */
describe('队首切换', () => {
  it('队首换成下一条后，理由输入框被清空', () => {
    render();
    typeReason('只针对这条');
    act(() => {
      root.render(
        <ApprovalDialog
          toolCall={{ ...TOOL_CALL, id: 'call-2' }}
          onApprove={onApprove}
          onReject={onReject}
          open={true}
          onClose={onClose}
          onMinimize={onMinimize}
          onRejectAndStop={onRejectAndStop}
        />,
      );
    });

    const input = container.querySelector<HTMLInputElement>('input[aria-label="拒绝原因"]')!;
    expect(input.value).toBe('');
    act(() => button('拒绝').click());
    expect(onReject).toHaveBeenCalledWith(undefined);
  });
});

/** 「拒绝并停止」：用户压根不想让 Agent 继续试。 */
describe('拒绝并停止任务', () => {
  it('走 onRejectAndStop 而不是 onReject', () => {
    render();
    act(() => button('拒绝并停止任务').click());

    expect(onRejectAndStop).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('理由同样带上', () => {
    render();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="拒绝原因"]')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '整条路都不对');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => button('拒绝并停止任务').click());

    expect(onRejectAndStop).toHaveBeenCalledWith('整条路都不对');
  });

  it('调用方没提供该能力时，按钮不出现', () => {
    render(true, false);
    const labels = Array.from(container.querySelectorAll('button')).map((b) =>
      b.textContent?.trim(),
    );
    expect(labels).not.toContain('拒绝并停止任务');
  });
});
