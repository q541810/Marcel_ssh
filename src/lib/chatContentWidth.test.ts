// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentContentMaxCss,
  CHAT_CONTENT_WIDTH_KEY,
  CONTENT_EDGE_BUDGET,
  CONTENT_MIN,
  readChatWidthPreference,
  resolveAgentContentWidth,
  writeChatWidthPreference,
} from './chatContentWidth';

describe('resolveAgentContentWidth（与 DSH resolveContentWidth 同口径）', () => {
  it('无偏好：自适应 = max(680, min(面板宽×0.64, 920))', () => {
    expect(resolveAgentContentWidth(1600, null)).toBe(920);
    expect(resolveAgentContentWidth(1000, null)).toBe(680); // 1000×0.64=640 → 抬到 680
    expect(resolveAgentContentWidth(460, null)).toBe(680); // 窄面板仍给下限（显示侧由 width:100% 钳制）
  });

  it('有偏好：钳到 [CONTENT_MIN, 面板宽−EDGE_BUDGET]', () => {
    expect(resolveAgentContentWidth(1600, 970)).toBe(970);
    expect(resolveAgentContentWidth(900, 970)).toBe(900 - CONTENT_EDGE_BUDGET);
    expect(resolveAgentContentWidth(1600, 100)).toBe(CONTENT_MIN);
  });
});

describe('agentContentMaxCss（dock 永远不限宽；拖拽偏好只在限宽的主区域布局生效）', () => {
  it('dock 布局（limitActive=false）即使设过拖拽偏好也必须不限宽', () => {
    // 回归：偏好从主区域布局漏进 dock，dock 里又没有把手能清掉它
    expect(agentContentMaxCss(900, 970, false)).toBe('none');
    expect(agentContentMaxCss(460, null, false)).toBe('none');
  });

  it('主区域布局（limitActive=true）：无偏好自适应，有偏好按偏好钳制', () => {
    expect(agentContentMaxCss(1600, null, true)).toBe('920px');
    expect(agentContentMaxCss(1600, 970, true)).toBe('970px');
    expect(agentContentMaxCss(900, 970, true)).toBe(`${900 - CONTENT_EDGE_BUDGET}px`);
  });
});

describe('偏好持久化（localStorage 边界）', () => {
  afterEach(() => {
    localStorage.removeItem(CHAT_CONTENT_WIDTH_KEY);
  });

  it('写入后可读回；null 移除；损坏值回落 null', () => {
    writeChatWidthPreference(970);
    expect(readChatWidthPreference()).toBe(970);
    expect(localStorage.getItem(CHAT_CONTENT_WIDTH_KEY)).toBe('970');

    writeChatWidthPreference(null);
    expect(readChatWidthPreference()).toBeNull();
    expect(localStorage.getItem(CHAT_CONTENT_WIDTH_KEY)).toBeNull();

    localStorage.setItem(CHAT_CONTENT_WIDTH_KEY, 'not-a-number');
    expect(readChatWidthPreference()).toBeNull();
    localStorage.setItem(CHAT_CONTENT_WIDTH_KEY, '-5');
    expect(readChatWidthPreference()).toBeNull();
  });
});
