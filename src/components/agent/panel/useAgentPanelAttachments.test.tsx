// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const tauriMocks = vi.hoisted(() => ({
  agentDeleteMessageImage: vi.fn(async () => {}),
}));

vi.mock('@/lib/tauri', () => ({
  agentDeleteMessageImage: tauriMocks.agentDeleteMessageImage,
}));

// compressImageFile 依赖 canvas（jsdom 没有）；revokePendingImages 依赖
// URL.revokeObjectURL（jsdom 没有）。这两个替换掉，其余（含
// deletePersistedImagePaths 的去重与 best-effort 语义）用真实实现。
vi.mock('@/lib/imageAttach', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/imageAttach')>()),
  revokePendingImages: vi.fn(),
  compressImageFile: vi.fn(async () => ({
    dataUrl: 'data:image/png;base64,AAA',
    previewUrl: 'blob:preview',
  })),
}));

// 文本大小上限在真实常量是 MB 级，测试里造不出真实大文件 —— 换成 1024 字节。
vi.mock('@/lib/attachmentAttach', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/attachmentAttach')>()),
  MAX_TEXT_FILE_BYTES: 1024,
}));

import {
  useAgentPanelAttachments,
  type AgentPanelAttachments,
} from './useAgentPanelAttachments';

let container: HTMLDivElement;
let root: Root;
let latest: AgentPanelAttachments | null = null;

type HookArgs = Parameters<typeof useAgentPanelAttachments>[0];

function Harness({ args }: { args: HookArgs }) {
  latest = useAgentPanelAttachments(args);
  return null;
}

async function renderHook(args: HookArgs) {
  await act(async () => {
    root.render(<Harness args={args} />);
  });
}

async function rerenderHook(args: HookArgs) {
  await act(async () => {
    root.render(<Harness args={args} />);
  });
}

const baseArgs = (overrides: Partial<HookArgs> = {}): HookArgs => ({
  visionEnabled: true,
  canInteract: true,
  activeConversationId: 'conv-1',
  setInput: vi.fn(),
  ...overrides,
});

function imageFile(name = 'pic.png'): File {
  return new File(['fake-png-bytes'], name, { type: 'image/png' });
}

beforeEach(() => {
  vi.clearAllMocks();
  latest = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useAgentPanelAttachments（原 AgentPanel 内联逻辑，行为不变）', () => {
  it('文本附件追加进草稿：更新函数吃到前值并带上文件名标记', async () => {
    const setInput = vi.fn();
    await renderHook(baseArgs({ setInput }));

    await act(async () => {
      await latest!.handleFileObjects([
        new File(['hello world'], 'note.txt', { type: 'text/plain' }),
      ]);
    });

    expect(setInput).toHaveBeenCalledTimes(1);
    const updater = setInput.mock.calls[0][0] as (prev: string) => string;
    expect(updater('之前的内容')).toContain('之前的内容');
    expect(updater('之前的内容')).toContain('note.txt');
    expect(updater('之前的内容')).toContain('hello world');
    expect(latest!.attachHint).toBeNull();
  });

  it('不支持的文件类型：明确提示而不是静默吞掉', async () => {
    await renderHook(baseArgs());

    await act(async () => {
      await latest!.handleFileObjects([
        new File(['PK'], 'archive.zip'),
        new File(['%PDF'], 'doc.pdf'),
      ]);
    });

    expect(latest!.attachHint).toContain('不支持的文件类型已跳过');
    expect(latest!.attachHint).toContain('archive.zip');
    expect(latest!.attachHint).toContain('doc.pdf');
  });

  it('超过文本大小上限的文件跳过并提示', async () => {
    await renderHook(baseArgs());

    await act(async () => {
      await latest!.handleFileObjects([
        // 真实上限是 MB 级造不出大文件；mock 后上限 1024，这里造 1100 字节超限
        new File([new Array(1100).fill('x').join('')], 'big.log', { type: 'text/plain' }),
      ]);
    });

    expect(latest!.attachHint).toContain('big.log');
    expect(latest!.attachHint).toContain('已跳过');
  });

  it('vision 关闭时收到图片：清空挂起图（删落盘图）并提示', async () => {
    await renderHook(baseArgs({ visionEnabled: false }));

    await act(async () => {
      await latest!.handleFileObjects([imageFile()]);
    });

    expect(latest!.pendingImages).toEqual([]);
    expect(latest!.attachHint).toBe('当前模型未开启「视觉 / 支持图片」');
  });

  it('vision 开启时收到图片：进预览区', async () => {
    await renderHook(baseArgs());

    await act(async () => {
      await latest!.handleFileObjects([imageFile()]);
    });

    expect(latest!.pendingImages).toHaveLength(1);
    expect(latest!.pendingImages[0].previewUrl).toBe('blob:preview');
  });

  it('切换会话丢掉草稿附件，落盘图一并删除（deleteDisk 语义）', async () => {
    await renderHook(baseArgs({ activeConversationId: 'conv-1' }));

    // 直接注入一条带 persistedPath 的挂起图（等价于撤回恢复后的形态）
    await act(async () => {
      latest!.setPendingImages([
        {
          id: 'img-1',
          previewUrl: 'blob:preview',
          dataUrl: 'data:image/png;base64,AAA',
          persistedPath: 'conv-1/m1_0.png',
        },
      ]);
    });
    expect(latest!.pendingImages).toHaveLength(1);

    await rerenderHook(baseArgs({ activeConversationId: 'conv-2' }));

    expect(latest!.pendingImages).toEqual([]);
    expect(tauriMocks.agentDeleteMessageImage).toHaveBeenCalledWith(
      'conv-1/m1_0.png',
    );
  });

  it('首次挂载不清理（prev === undefined 的兼容分支）', async () => {
    await renderHook(baseArgs({ activeConversationId: 'conv-1' }));

    await act(async () => {
      latest!.setPendingImages([
        { id: 'img-1', previewUrl: 'blob:preview', dataUrl: 'data:...' },
      ]);
    });

    // 同一会话的 rerender 不该清
    await rerenderHook(baseArgs({ activeConversationId: 'conv-1' }));
    expect(latest!.pendingImages).toHaveLength(1);
    expect(tauriMocks.agentDeleteMessageImage).not.toHaveBeenCalled();
  });

  it('removePendingImage：从预览移除并删除落盘图', async () => {
    await renderHook(baseArgs());

    await act(async () => {
      latest!.setPendingImages([
        { id: 'a', previewUrl: 'blob:a', dataUrl: 'data:a', persistedPath: 'p/a.png' },
        { id: 'b', previewUrl: 'blob:b', dataUrl: 'data:b' },
      ]);
    });

    await act(async () => {
      latest!.removePendingImage('a');
    });

    expect(latest!.pendingImages.map((p) => p.id)).toEqual(['b']);
    expect(tauriMocks.agentDeleteMessageImage).toHaveBeenCalledWith('p/a.png');
  });

  it('vision 由开变关时清空已挂起的图片并提示（独立于会话切换）', async () => {
    await renderHook(baseArgs({ visionEnabled: true }));
    await act(async () => {
      latest!.setPendingImages([
        { id: 'a', previewUrl: 'blob:a', dataUrl: 'data:a', persistedPath: 'p/a.png' },
      ]);
    });

    await rerenderHook(baseArgs({ visionEnabled: false }));

    expect(latest!.pendingImages).toEqual([]);
    expect(latest!.attachHint).toBe('当前模型未开启「视觉 / 支持图片」');
    expect(tauriMocks.agentDeleteMessageImage).toHaveBeenCalledWith('p/a.png');
  });
});
