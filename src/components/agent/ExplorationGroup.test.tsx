import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/lib/types';
import { isExplorationTool, isPlanToolMessage } from '@/components/agent/ExplorationGroup';

function makeToolMessage(toolName: string): AgentMessage {
  return {
    id: toolName,
    role: 'tool',
    content: '',
    timestamp: '2026-01-01T00:00:00Z',
    toolResult: {
      toolName,
      summary: '',
      result: '',
      success: true,
      blocked: false,
    },
  };
}

describe('isExplorationTool', () => {
  it('treats search and read tools as exploration', () => {
    for (const toolName of ['web_search', 'http_get', 'read_file', 'search_files', 'list_directory']) {
      expect(isExplorationTool(makeToolMessage(toolName)), toolName).toBe(true);
    }
  });

  it('does not treat mutation or command tools as exploration', () => {
    expect(isExplorationTool(makeToolMessage('write_file'))).toBe(false);
    expect(isExplorationTool(makeToolMessage('execute_command'))).toBe(false);
  });
});

describe('isPlanToolMessage', () => {
  it('treats plan tools as plan messages', () => {
    for (const toolName of ['create_plan', 'update_plan_item', 'edit_plan']) {
      expect(isPlanToolMessage(makeToolMessage(toolName)), toolName).toBe(true);
    }
  });

  it('does not treat other tools as plan messages', () => {
    expect(isPlanToolMessage(makeToolMessage('read_file'))).toBe(false);
    expect(isPlanToolMessage(makeToolMessage('write_file'))).toBe(false);
    expect(isPlanToolMessage(makeToolMessage('execute_command'))).toBe(false);
  });

  it('returns false for non-tool messages', () => {
    const assistantMsg: AgentMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'thinking',
      timestamp: '2026-01-01T00:00:00Z',
      toolCall: { id: 'tc1', name: 'create_plan', arguments: {}, riskLevel: 'LowRisk' },
    };
    expect(isPlanToolMessage(assistantMsg)).toBe(false);
  });
});
