// @vitest-environment jsdom
// jsdom：展开态要点标题行，摘要行要读真实 zustand store（与 ToolCallCard 的用例
// 同一套做法）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AgentMessage from '@/components/agent/AgentMessage';
import { useJobStore } from '@/stores/jobStore';
import type { AgentMessage as AgentMessageType } from '@/lib/types';

// 与 AgentMessageList 的用例同一套桩：只用得上「思考显示」那个开关，但真实
// settingsStore 会把一堆无关依赖拖进 import 图。
vi.mock('@/stores/settingsStore', () => {
  const state = { settings: { foldCompletedTurns: false } };
  return {
    useSettingsStore: (selector?: (s: unknown) => unknown) =>
      selector ? selector(state) : state,
  };
});

vi.mock('@/lib/externalLinks', () => ({
  openExternalLink: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 后端 `build_job_settlement_notice` 的真实产物形状。 */
const NOTE_LINE =
  '用 job_output(job_id=...) 读取其输出并纳入结论；若作业已不再需要，可用 job_kill 终止。';
const ONE_JOB = ['后台作业 job_3（构建）已完成', NOTE_LINE].join('\n');

function noticeMessage(content: string): AgentMessageType {
  return {
    id: 'notice-1',
    role: 'notice',
    content,
    timestamp: '2026-01-01T00:00:00Z',
  };
}

/** 把某个作业放进作业 store（摘要行要照抄 bash 卡的 `$ 命令`）。 */
function seedJob(jobId: string, command: string) {
  useJobStore.setState({
    jobs: {
      [jobId]: {
        jobId,
        sessionId: 's1',
        taskId: 't1',
        ownerConversationId: 'c1',
        description: '构建',
        command,
        status: 'completed',
        startedAtMillis: 1,
        finishedAtMillis: 2,
        totalOutputBytes: 10,
      },
    },
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  useJobStore.setState({ jobs: {} });
});

function mount(content: string): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<AgentMessage message={noticeMessage(content)} />);
  });
  return container;
}

/** 展开卡片（点标题行按钮）。 */
function expand(el: HTMLElement) {
  const button = el.querySelector('button');
  expect(button, '标题行应是一个可点的按钮').not.toBeNull();
  act(() => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * 「系统告知」卡（role=notice）的呈现。
 *
 * 它长成工具卡的形态（同一个 `ToolCardFrame` 骨架），摘要行也照抄当初那条 bash
 * 卡（`$ 命令`）：**折叠态不放状态胶囊** —— 正常结束就安安静静一张卡，出问题才
 * 靠色调与展开区里的状态字出声。给模型的那句操作说明默认收起。
 */
describe('系统告知卡', () => {
  it('单作业折叠态：胶囊 + $ 命令（与 bash 卡同一行），不摊状态、不摊指令', () => {
    seedJob('job_3', 'pnpm build');
    const el = mount(ONE_JOB);

    expect(el.textContent).toContain('后台作业');
    expect(el.textContent).toContain('$ pnpm build');
    // 「已完成」这类状态不进折叠态（展开区里才有）
    expect(el.textContent).not.toContain('已完成');
    // 给模型的指令同样不进折叠态
    expect(el.textContent).not.toContain('job_output(job_id=...)');
    expect(el.textContent).not.toContain('系统告知');
  });

  it('作业查不到了（重启后又过了台账保留期）→ 摘要回落成告知里的描述', () => {
    const el = mount(ONE_JOB);

    expect(el.textContent).toContain('构建');
    expect(el.textContent).not.toContain('$ pnpm build');
  });

  it('展开态：每个作业一行（带状态，含 id）+ 给模型的指令', () => {
    seedJob('job_3', 'pnpm build');
    const el = mount(ONE_JOB);
    expect(el.textContent).not.toContain('已完成');

    expand(el);

    expect(el.textContent).toContain('job_3');
    expect(el.textContent).toContain('已完成');
    expect(el.textContent).toContain('job_output(job_id=...)');
  });

  it('多作业：摘要列 id，展开后逐个列状态', () => {
    const el = mount(
      [
        '后台作业 job_3（构建）已完成',
        '后台作业 job_4（部署）执行失败',
        '后台作业 job_5（清理）已被终止',
        NOTE_LINE,
      ].join('\n'),
    );

    expect(el.textContent).toContain('job_3、job_4、job_5');
    expect(el.textContent).not.toContain('已完成');

    expand(el);

    expect(el.textContent).toContain('执行失败');
    expect(el.textContent).toContain('已被终止');
  });

  it('作业很多时摘要收口成「等 N 个作业」', () => {
    const el = mount(
      ['job_1', 'job_2', 'job_3', 'job_4', 'job_5']
        .map((id) => `后台作业 ${id}（构建）已完成`)
        .concat(NOTE_LINE)
        .join('\n'),
    );

    expect(el.textContent).toContain('job_1、job_2、job_3 等 5 个作业');
  });

  it('描述里带全角括号：仍按作业行认，不串到状态里去', () => {
    const el = mount('后台作业 job_7（构建（release））执行失败\n用 job_output 读输出。');

    expect(el.textContent).toContain('构建（release）');
    // 状态不进折叠态，但「没跑好」这件事要靠卡片色调说出来
    expect(el.textContent).not.toContain('执行失败');
    expect(el.innerHTML).toContain('text-red-400');
  });

  it('认不出的措辞：照原样显示，不吞内容', () => {
    // 后端换了行格式（这里是假设的形态）：界面回落成「第一行当摘要、其余收起」，
    // 胶囊换成「系统告知」，而不是把整条告知渲染成空白。
    const el = mount('作业 job_9 结束了\n（这是一句没被格式化的说明）');

    expect(el.textContent).toContain('作业 job_9 结束了');
    expect(el.textContent).toContain('系统告知');
  });
});
