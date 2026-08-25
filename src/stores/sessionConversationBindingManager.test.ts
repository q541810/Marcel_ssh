import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/terminal/TerminalInstanceManager', () => ({
  terminalInstanceManager: {
    prepareReconnect: vi.fn(),
    onReconnected: vi.fn(),
    showDisconnectBanner: vi.fn(),
    setStdinEnabled: vi.fn(),
  },
}));

vi.mock('@/lib/tauri', () => ({
  agentListConversationsByConnection: vi.fn(),
  agentLoadConversation: vi.fn(),
  agentLoadPlansByConversation: vi.fn(),
  agentGetConversation: vi.fn(),
  agentCreateConversation: vi.fn(),
  agentRenameConversation: vi.fn(),
  agentDeleteConversation: vi.fn(),
  agentTruncateConversation: vi.fn(),
}));

import { useSessionStore } from '@/stores/sessionStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useTaskStore } from '@/stores/taskStore';
import { sessionConversationBindingManager } from '@/stores/sessionConversationBindingManager';
import type { Session, AgentConversation, AgentTask } from '@/lib/types';
import * as tauri from '@/lib/tauri';

describe('SessionConversationBindingManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({
      sessions: {},
      activeSessionId: null,
    });
    useConversationStore.setState({
      conversations: {},
      messages: {},
      activeConversationId: null,
      activeConversationByConnection: {},
      activeConversationBySession: {},
    });
    useTaskStore.setState({
      tasks: {},
      activeTaskId: null,
      unreadCompletedConversations: [],
    });
  });

  it('detects occupying session via running task', () => {
    const sessionA: Session = {
      id: 'sess-a',
      connectionId: 'hostA',
      status: 'connected',
      createdAt: '',
      configId: 'conn-1',
    };
    useSessionStore.setState({
      sessions: { 'sess-a': sessionA },
      activeSessionId: 'sess-a',
    });

    const task: AgentTask = {
      id: 'task-1',
      sessionId: 'sess-a',
      conversationId: 'conv-n',
      prompt: 'do work',
      mode: 'agent',
      status: 'executing',
      createdAt: '',
    };
    useTaskStore.setState({
      tasks: { 'task-1': task },
    });

    const occupying = sessionConversationBindingManager.findOccupyingSession('conv-n');
    expect(occupying).not.toBeNull();
    expect(occupying?.sessionId).toBe('sess-a');
  });

  it('detects occupying session via activeConversationBySession', () => {
    const sessionA: Session = {
      id: 'sess-a',
      connectionId: 'hostA',
      status: 'connected',
      createdAt: '',
      configId: 'conn-1',
    };
    useSessionStore.setState({
      sessions: { 'sess-a': sessionA },
      activeSessionId: 'sess-a',
    });

    useConversationStore.setState({
      activeConversationBySession: { 'sess-a': 'conv-n' },
    });

    const occupying = sessionConversationBindingManager.findOccupyingSession('conv-n');
    expect(occupying).not.toBeNull();
    expect(occupying?.sessionId).toBe('sess-a');
  });

  it('jumps to session A when clicking conversation N from session B', async () => {
    const sessionA: Session = {
      id: 'sess-a',
      connectionId: 'hostA',
      status: 'connected',
      createdAt: '',
      configId: 'conn-1',
    };
    const sessionB: Session = {
      id: 'sess-b',
      connectionId: 'hostA',
      status: 'connected',
      createdAt: '',
      configId: 'conn-1',
    };
    useSessionStore.setState({
      sessions: { 'sess-a': sessionA, 'sess-b': sessionB },
      activeSessionId: 'sess-b',
    });

    useConversationStore.setState({
      conversations: {
        'conv-n': {
          id: 'conv-n',
          connectionId: 'conn-1',
          title: 'Conv N',
          createdAt: '',
          updatedAt: '',
        },
      },
      activeConversationBySession: { 'sess-a': 'conv-n' },
      activeConversationId: 'conv-other',
    });

    (tauri.agentLoadConversation as any).mockResolvedValue([]);
    (tauri.agentLoadPlansByConversation as any).mockResolvedValue([]);

    const result = await sessionConversationBindingManager.selectOrJumpToConversation(
      'conv-n',
      'sess-b',
    );

    expect(result.switchedSession).toBe(true);
    expect(result.targetSessionId).toBe('sess-a');
    expect(useSessionStore.getState().activeSessionId).toBe('sess-a');
    expect(useConversationStore.getState().activeConversationId).toBe('conv-n');
  });

  it('allocates a fresh conversation on connect when all existing conversations are occupied by other live tabs', async () => {
    const sessionA: Session = {
      id: 'sess-a',
      connectionId: 'hostA',
      status: 'connected',
      createdAt: '',
      configId: 'conn-1',
    };
    useSessionStore.setState({
      sessions: { 'sess-a': sessionA },
      activeSessionId: 'sess-a',
    });

    useConversationStore.setState({
      conversations: {
        'conv-n': {
          id: 'conv-n',
          connectionId: 'conn-1',
          title: 'Conv N',
          createdAt: '',
          updatedAt: '2026-01-01',
        },
      },
      activeConversationBySession: { 'sess-a': 'conv-n' },
    });

    (tauri.agentListConversationsByConnection as any).mockResolvedValue([
      {
        id: 'conv-n',
        connectionId: 'conn-1',
        title: 'Conv N',
        createdAt: '',
        updatedAt: '2026-01-01',
      },
    ]);
    (tauri.agentCreateConversation as any).mockResolvedValue('conv-b-fresh');

    const allocatedId = await sessionConversationBindingManager.onSessionConnected('conn-1', 'sess-b');
    expect(allocatedId).toBe('conv-b-fresh');
    expect(useConversationStore.getState().activeConversationBySession['sess-b']).toBe('conv-b-fresh');
    expect(useConversationStore.getState().activeConversationBySession['sess-a']).toBe('conv-n');
  });

  it('cleans up session binding upon disconnect', () => {
    useConversationStore.setState({
      activeConversationBySession: { 'sess-a': 'conv-n' },
    });

    sessionConversationBindingManager.onSessionDisconnected('sess-a');
    expect(useConversationStore.getState().activeConversationBySession['sess-a']).toBeUndefined();
  });
});
