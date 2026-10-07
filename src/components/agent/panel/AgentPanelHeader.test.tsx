// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { JobInfo } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  jobs: {} as Record<string, JobInfo>,
  readInterrupted: {} as Record<string, number>,
}));

vi.mock('@/stores/jobStore', () => ({
  useJobStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      jobs: mocks.jobs,
      killJob: vi.fn(),
      readInterrupted: mocks.readInterrupted,
    }),
}));

// MultiHostPicker 是头部的无条件子组件，它的数据来源在此替换为空集。
vi.mock('@/hooks/usePrivacyMode', () => ({
  usePrivacyMode: () => false,
}));
vi.mock('@/stores/connectionStore', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ connections: [], fetchConnections: vi.fn() }),
}));
vi.mock('@/stores/sessionStore', () => ({
  useSessionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ sessions: {}, activeSessionId: null }),
}));
vi.mock('@/stores/settingsStore', () => ({
  DEFAULT_EXPERIMENTAL_SETTINGS: { multiHostConnectionIds: [] },
  useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      settings: { experimentalSettings: { multiHostConnectionIds: [] } },
      update: vi.fn(),
    }),
}));

import { AgentPanelHeader } from './AgentPanelHeader';
import type { ConversationUsageView } from '@/lib/tokenUsage';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.jobs = {};
  mocks.readInterrupted = {};
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

type HeaderProps = React.ComponentProps<typeof AgentPanelHeader>;

const baseProps = (overrides: Partial<HeaderProps> = {}): HeaderProps => ({
  activeUsageView: {
    usage: {
      promptTokens: 1000,
      completionTokens: 100,
      totalTokens: 1100,
      lastContext: {
        usedTokens: 1000,
        estimated: false,
        systemTokens: 10,
        toolsTokens: 20,
        messageTokens: 970,
      },
    },
    windowTokens: 100000,
    estimated: false,
  } as ConversationUsageView,
  tasks: {},
  activeConversationId: 'conv-1',
  canInteract: true,
  onNewConversation: vi.fn(),
  onHistoryClick: vi.fn(),
  onOpenTaskCenter: vi.fn(),
  ...overrides,
});

function jobInfo(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    jobId: 'job-1',
    sessionId: 's1',
    taskId: null,
    description: '构建',
    command: 'pnpm build',
    status: 'running',
    ownerConversationId: 'conv-1',
    detail: null,
    startedAtMillis: 1000,
    finishedAtMillis: null,
    totalOutputBytes: 10,
    ...overrides,
  };
}

describe('AgentPanelHeader（原 AgentPanel 内联头部，行为不变）', () => {
  it('渲染标题与三个常驻按钮，无事发生时任务胶囊不出现', async () => {
    await act(async () => {
      root.render(<AgentPanelHeader {...baseProps()} />);
    });

    expect(container.textContent).toContain('智能助手');
    expect(container.querySelector('button[title="新建会话"]')).not.toBeNull();
    expect(container.querySelector('button[title="历史会话"]')).not.toBeNull();
    expect(container.textContent).not.toContain('个任务');
  });

  it('有运行中后台作业时出现胶囊，点击带出作业页签', async () => {
    mocks.jobs = { 'job-1': jobInfo() };
    const onOpenTaskCenter = vi.fn();
    await act(async () => {
      root.render(<AgentPanelHeader {...baseProps({ onOpenTaskCenter })} />);
    });

    expect(container.textContent).toContain('1 个后台作业');
    const pill = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('个后台作业'),
    )!;
    await act(async () => {
      pill.click();
    });

    expect(onOpenTaskCenter).toHaveBeenCalledWith('jobs');
  });

  it('只有中断作业（重启恢复）也必须给入口：文案指向未知结局', async () => {
    mocks.jobs = { 'job-1': jobInfo({ status: 'interrupted' }) };
    await act(async () => {
      root.render(<AgentPanelHeader {...baseProps()} />);
    });

    expect(container.textContent).toContain('1 个作业已中断');
  });

  it('读过结局说明的 interrupted 不再挂警示胶囊（已读记账，双端同口径）', async () => {
    mocks.jobs = {
      'job-1': jobInfo({ status: 'interrupted' }),
      'job-2': jobInfo({ jobId: 'job-2', status: 'interrupted', startedAtMillis: 2 }),
    };
    mocks.readInterrupted = { 'job-1': 1, 'job-2': 2 };
    await act(async () => {
      root.render(<AgentPanelHeader {...baseProps()} />);
    });

    expect(container.textContent).not.toContain('个作业已中断');
  });

  it('只读过一部分时未读的照旧挂警示，计数只算未读', async () => {
    mocks.jobs = {
      'job-1': jobInfo({ status: 'interrupted' }),
      'job-2': jobInfo({ jobId: 'job-2', status: 'interrupted', startedAtMillis: 2 }),
    };
    mocks.readInterrupted = { 'job-1': 1 };
    await act(async () => {
      root.render(<AgentPanelHeader {...baseProps()} />);
    });

    expect(container.textContent).toContain('1 个作业已中断');
  });

  it('历史按钮：点击走 onHistoryClick（连接中开抽屉 / 未连接开模态由父级判定）', async () => {
    const onHistoryClick = vi.fn();
    await act(async () => {
      root.render(<AgentPanelHeader {...baseProps({ onHistoryClick })} />);
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="历史会话"]')!.click();
    });
    expect(onHistoryClick).toHaveBeenCalledTimes(1);
  });

  it('未连接：新建会话按钮禁用', async () => {
    await act(async () => {
      root.render(<AgentPanelHeader {...baseProps({ canInteract: false })} />);
    });

    const newButton = container.querySelector<HTMLButtonElement>('button[title="新建会话"]')!;
    expect(newButton.disabled).toBe(true);
  });

  it('占用环按钮：点开 Token 用量浮层，显示用量面板', async () => {
    await act(async () => {
      root.render(<AgentPanelHeader {...baseProps()} />);
    });

    const meterButton = container.querySelector<HTMLButtonElement>('button[aria-label="Token 用量"]')!;
    expect(meterButton.getAttribute('title')).toContain('上下文占用');

    await act(async () => {
      meterButton.click();
    });
    expect(container.textContent).toContain('Token 用量');
    expect(meterButton.getAttribute('aria-expanded')).toBe('true');
  });
});
