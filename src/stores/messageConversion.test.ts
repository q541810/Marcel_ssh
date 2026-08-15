import { describe, it, expect } from 'vitest';
import { storedMessageToAgentMessage, clearIntermediateReasoning } from './messageConversion';
import type { StoredMessage } from '@/lib/types';

describe('storedMessageToAgentMessage', () => {
  // Helper to create base StoredMessage
  const createStoredMessage = (overrides: Partial<StoredMessage> = {}): StoredMessage => ({
    id: 'msg-1',
    conversationId: 'conv-1',
    role: 'user',
    content: 'Hello',
    timestamp: '2024-01-01T00:00:00Z',
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  });

  describe('basic message conversion', () => {
    it('should convert a simple user message', () => {
      const stored = createStoredMessage({ role: 'user', content: 'Hello world' });
      const result = storedMessageToAgentMessage(stored);

      expect(result.id).toBe('msg-1');
      expect(result.role).toBe('user');
      expect(result.content).toBe('Hello world');
      expect(result.timestamp).toBe('2024-01-01T00:00:00Z');
      expect(result.toolCall).toBeUndefined();
      expect(result.toolResult).toBeUndefined();
    });

    it('should convert a system message', () => {
      const stored = createStoredMessage({ role: 'system', content: 'System info' });
      const result = storedMessageToAgentMessage(stored);

      expect(result.role).toBe('system');
      expect(result.content).toBe('System info');
      expect(result.toolCall).toBeUndefined();
      expect(result.toolResult).toBeUndefined();
    });
  });

  describe('legacy tool result messages (no toolCallsJson)', () => {
    it('should handle legacy tool result with execute_command default', () => {
      const stored = createStoredMessage({
        role: 'tool',
        content: 'Command output here',
        toolCallsJson: null,
      });
      const result = storedMessageToAgentMessage(stored);

      expect(result.toolResult).toBeDefined();
      expect(result.toolResult!.toolName).toBe('execute_command');
      expect(result.toolResult!.result).toBe('Command output here');
      expect(result.toolResult!.success).toBe(true);
      expect(result.toolResult!.blocked).toBe(false);
    });

    it('should extract tool name from content prefix', () => {
      const stored = createStoredMessage({
        role: 'tool',
        content: '[read_file] File content here',
        toolCallsJson: null,
      });
      const result = storedMessageToAgentMessage(stored);

      expect(result.toolResult!.toolName).toBe('read_file');
    });

    it('should truncate long content in summary', () => {
      const longContent = 'a'.repeat(100);
      const stored = createStoredMessage({
        role: 'tool',
        content: longContent,
        toolCallsJson: null,
      });
      const result = storedMessageToAgentMessage(stored);

      expect(result.toolResult!.summary).toBe('a'.repeat(60) + '...');
    });

    it('should handle empty content', () => {
      const stored = createStoredMessage({
        role: 'tool',
        content: '',
        toolCallsJson: null,
      });
      const result = storedMessageToAgentMessage(stored);

      expect(result.toolResult!.summary).toBe('(done)');
    });

    it('should detect blocked commands', () => {
      const stored = createStoredMessage({
        role: 'tool',
        content: 'BLOCKED: dangerous command',
        toolCallsJson: null,
      });
      const result = storedMessageToAgentMessage(stored);

      expect(result.toolResult!.blocked).toBe(true);
      expect(result.toolResult!.success).toBe(false);
    });

    it('should detect tool errors', () => {
      const stored = createStoredMessage({
        role: 'tool',
        content: 'tool error: something failed',
        toolCallsJson: null,
      });
      const result = storedMessageToAgentMessage(stored);

      expect(result.toolResult!.success).toBe(false);
      expect(result.toolResult!.blocked).toBe(false);
    });
  });

  describe('assistant messages with toolCallsJson', () => {
    it('should convert assistant tool call message', () => {
      const toolCalls = [{
        id: 'call-1',
        name: 'execute_command',
        arguments: { command: 'ls -la' },
        risk_level: 'Moderate',
      }];
      const stored = createStoredMessage({
        role: 'assistant',
        content: '',
        toolCallsJson: JSON.stringify(toolCalls),
      });
      const result = storedMessageToAgentMessage(stored);

      // reload 只恢复 toolCalls，不设 toolCall（避免 UI 重复 tool 卡片）
      expect(result.toolCall).toBeUndefined();
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].id).toBe('call-1');
      expect(result.toolCalls![0].name).toBe('execute_command');
      expect(result.toolCalls![0].arguments).toEqual({ command: 'ls -la' });
      expect(result.toolCalls![0].riskLevel).toBe('Moderate');
    });

    it('应把并行 tool calls 全部保留在 assistant.toolCalls', () => {
      const toolCalls = [
        {
          id: 'call-a',
          name: 'execute_command',
          arguments: { command: 'ls' },
        },
        {
          id: 'call-b',
          name: 'system_info',
          arguments: { category: 'os' },
        },
      ];
      const stored = createStoredMessage({
        role: 'assistant',
        content: 'Checking...',
        toolCallsJson: JSON.stringify(toolCalls),
      });
      const result = storedMessageToAgentMessage(stored);

      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls![0].name).toBe('execute_command');
      expect(result.toolCalls![1].name).toBe('system_info');
      expect(result.toolCall).toBeUndefined();
    });

    it('should handle single tool call (not array)', () => {
      const toolCall = {
        id: 'call-1',
        name: 'read_file',
        arguments: { path: '/etc/hosts' },
        risk_level: 'ReadOnly',
      };
      const stored = createStoredMessage({
        role: 'assistant',
        content: '',
        toolCallsJson: JSON.stringify(toolCall),
      });
      const result = storedMessageToAgentMessage(stored);

      expect(result.toolCall).toBeUndefined();
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].name).toBe('read_file');
    });

    it('should handle empty tool calls array', () => {
      const stored = createStoredMessage({
        role: 'assistant',
        content: 'No tools',
        toolCallsJson: JSON.stringify([]),
      });
      const result = storedMessageToAgentMessage(stored);

      expect(result.toolCall).toBeUndefined();
      expect(result.content).toBe('No tools');
    });
  });

  describe('tool messages with new format toolCallsJson', () => {
    it('should convert new format tool result', () => {
      const toolResult = {
        id: 'call-1',
        name: 'execute_command',
        arguments: { command: 'ls' },
        risk_level: 'LowRisk',
        summary: 'Command executed',
        success: true,
        blocked: false,
      };
      const stored = createStoredMessage({
        role: 'tool',
        content: 'total 128\ndrwxr-xr-x  5 user group  160 Jan  1 00:00 .',
        toolCallsJson: JSON.stringify(toolResult),
      });
      const result = storedMessageToAgentMessage(stored);

      expect(result.toolResult).toBeDefined();
      expect(result.toolResult!.toolName).toBe('execute_command');
      expect(result.toolResult!.summary).toBe('Command executed');
      expect(result.toolResult!.success).toBe(true);
      expect(result.toolResult!.blocked).toBe(false);
      expect(result.toolResult!.arguments).toEqual({ command: 'ls' });
      expect(result.toolResult!.toolCallId).toBe('call-1');
    });

    it('should use content as fallback summary', () => {
      const toolResult = {
        id: 'call-1',
        name: 'read_file',
        arguments: { path: '/etc/hosts' },
        risk_level: 'ReadOnly',
        success: true,
        blocked: false,
      };
      const stored = createStoredMessage({
        role: 'tool',
        content: '127.0.0.1 localhost',
        toolCallsJson: JSON.stringify(toolResult),
      });
      const result = storedMessageToAgentMessage(stored);

      expect(result.toolResult!.summary).toBe('127.0.0.1 localhost');
    });

    it('should handle blocked tool result', () => {
      const toolResult = {
        id: 'call-1',
        name: 'execute_command',
        arguments: { command: 'rm -rf /' },
        risk_level: 'Destructive',
        summary: 'Blocked by sandbox',
        success: false,
        blocked: true,
      };
      const stored = createStoredMessage({
        role: 'tool',
        content: 'BLOCKED by sandbox',
        toolCallsJson: JSON.stringify(toolResult),
      });
      const result = storedMessageToAgentMessage(stored);

      expect(result.toolResult!.blocked).toBe(true);
      expect(result.toolResult!.success).toBe(false);
    });

    it('should preserve timeout status from persisted tool result', () => {
      const toolResult = {
        id: 'call-1',
        name: 'execute_command',
        arguments: { command: 'sleep 999' },
        risk_level: 'LowRisk',
        summary: '$ sleep 999',
        success: true,
        blocked: false,
        was_timeout: true,
      };
      const stored = createStoredMessage({
        role: 'tool',
        content: '命令执行在 60 秒后超时，已停止等待输出',
        toolCallsJson: JSON.stringify(toolResult),
      });
      const result = storedMessageToAgentMessage(stored);

      expect(result.toolResult!.wasTimeout).toBe(true);
    });

    it('should keep old persisted tool results without timeout as non-timeout', () => {
      const toolResult = {
        id: 'call-1',
        name: 'execute_command',
        arguments: { command: 'ls' },
        risk_level: 'LowRisk',
        summary: '$ ls',
        success: true,
        blocked: false,
      };
      const stored = createStoredMessage({
        role: 'tool',
        content: 'ok',
        toolCallsJson: JSON.stringify(toolResult),
      });
      const result = storedMessageToAgentMessage(stored);

      expect(result.toolResult!.wasTimeout).toBeUndefined();
    });
  });

  describe('tool messages with legacy format toolCallsJson', () => {
    it('should convert legacy array format tool result', () => {
      const toolCalls = [{
        id: 'call-1',
        name: 'execute_command',
        arguments: { command: 'pwd' },
        risk_level: 'ReadOnly',
      }];
      const stored = createStoredMessage({
        role: 'tool',
        content: '/home/user',
        toolCallsJson: JSON.stringify(toolCalls),
      });
      const result = storedMessageToAgentMessage(stored);

      expect(result.toolResult).toBeDefined();
      expect(result.toolResult!.toolName).toBe('execute_command');
      expect(result.toolResult!.arguments).toEqual({ command: 'pwd' });
      expect(result.toolResult!.toolCallId).toBe('call-1');
    });

    it('should detect blocked status from content in legacy format', () => {
      const toolCalls = [{
        id: 'call-1',
        name: 'execute_command',
        arguments: { command: 'dangerous' },
      }];
      const stored = createStoredMessage({
        role: 'tool',
        content: 'BLOCKED: dangerous command detected',
        toolCallsJson: JSON.stringify(toolCalls),
      });
      const result = storedMessageToAgentMessage(stored);

      expect(result.toolResult!.blocked).toBe(true);
      expect(result.toolResult!.success).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should handle invalid JSON in toolCallsJson', () => {
      const stored = createStoredMessage({
        role: 'assistant',
        content: 'Error message',
        toolCallsJson: 'invalid json {',
      });
      const result = storedMessageToAgentMessage(stored);

      // Should return base message without tool info
      expect(result.content).toBe('Error message');
      expect(result.toolCall).toBeUndefined();
    });

    it('should handle null toolCallsJson', () => {
      const stored = createStoredMessage({
        role: 'assistant',
        content: 'Normal message',
        toolCallsJson: null,
      });
      const result = storedMessageToAgentMessage(stored);

      expect(result.content).toBe('Normal message');
      expect(result.toolCall).toBeUndefined();
    });

    it('should handle undefined toolCallsJson', () => {
      const stored = createStoredMessage({
        role: 'assistant',
        content: 'Normal message',
      });
      const result = storedMessageToAgentMessage(stored);

      expect(result.content).toBe('Normal message');
      expect(result.toolCall).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('should handle message with special characters in content', () => {
      const stored = createStoredMessage({
        role: 'tool',
        content: 'Error: file not found 🚫',
        toolCallsJson: null,
      });
      const result = storedMessageToAgentMessage(stored);

      expect(result.toolResult!.result).toBe('Error: file not found 🚫');
    });

    it('should handle very long content', () => {
      const longContent = 'line\n'.repeat(1000);
      const stored = createStoredMessage({
        role: 'tool',
        content: longContent,
        toolCallsJson: null,
      });
      const result = storedMessageToAgentMessage(stored);

      expect(result.toolResult!.result).toBe(longContent);
      expect(result.toolResult!.summary).toContain('...');
    });

    it('should handle mixed format in same conversation', () => {
      // This simulates a conversation with both legacy and new format messages
      const legacyMsg = createStoredMessage({
        role: 'tool',
        content: '[execute_command] Output',
        toolCallsJson: null,
      });
      const newMsg = createStoredMessage({
        role: 'tool',
        content: 'Output',
        toolCallsJson: JSON.stringify({
          id: 'call-1',
          name: 'read_file',
          arguments: {},
          success: true,
          blocked: false,
        }),
      });

      const legacyResult = storedMessageToAgentMessage(legacyMsg);
      const newResult = storedMessageToAgentMessage(newMsg);

      expect(legacyResult.toolResult!.toolName).toBe('execute_command');
      expect(newResult.toolResult!.toolName).toBe('read_file');
    });
  });
});

describe('clearIntermediateReasoning', () => {
  it('keeps reasoningContent but clears isThinking for assistant followed by tool', () => {
    const assistant = storedMessageToAgentMessage({
      id: 'a1',
      conversationId: 'c1',
      role: 'assistant',
      content: 'checking',
      timestamp: 't',
      createdAt: 't',
      reasoningContent: 'thinking...',
    });
    const tool = storedMessageToAgentMessage({
      id: 't1',
      conversationId: 'c1',
      role: 'tool',
      content: '',
      timestamp: 't',
      createdAt: 't',
      toolCallsJson: JSON.stringify({
        id: 'call-1',
        name: 'read_file',
        arguments: {},
        success: true,
        blocked: false,
      }),
    });

    const result = clearIntermediateReasoning([
      { ...assistant, isThinking: true },
      tool,
    ]);

    // reasoningContent 保留（LLM 回传需要，DeepSeek thinking 模式）
    expect(result[0].reasoningContent).toBe('thinking...');
    // 显示标志清除（UI 不显示"思考中"）
    expect(result[0].isThinking).toBe(false);
  });
});
