import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/lib/types';
import { isExplorationTool } from '@/components/agent/ExplorationGroup';

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
