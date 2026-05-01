import { useState, useRef, useEffect } from 'react';
import { useAgent } from '@/hooks/useAgent';
import { useSessionStore } from '@/stores/sessionStore';
import { AGENT_MODES } from '@/lib/constants';
import type { AgentMode } from '@/lib/types';
import AgentMessageItem from './AgentMessage';
import ToolCallCard from './ToolCallCard';
import ApprovalDialog from './ApprovalDialog';
import Button from '@/components/ui/Button';

export default function AgentPanel() {
  const [input, setInput] = useState('');
  const [modeDrawerOpen, setModeDrawerOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const { messages, startTask, stopTask, activeTask, mode, setMode, isRunning, pendingApproval, approve, reject } =
    useAgent();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Close the mode drawer when clicking outside of it.
  useEffect(() => {
    if (!modeDrawerOpen) return;
    const handler = (e: MouseEvent) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        setModeDrawerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modeDrawerOpen]);

  const handleSend = async () => {
    const prompt = input.trim();
    if (!prompt || !activeSessionId) return;
    setInput('');
    try {
      await startTask(activeSessionId, prompt);
    } catch (err) {
      console.error('Failed to start task:', err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleStop = () => {
    if (activeTask) {
      stopTask(activeTask.id);
    }
  };

  const handleApprove = async () => {
    if (pendingApproval && activeTask) {
      await approve(activeTask.id, pendingApproval.toolCallId);
    }
  };

  const handleReject = async () => {
    if (pendingApproval && activeTask) {
      await reject(activeTask.id, pendingApproval.toolCallId);
    }
  };

  const currentModeInfo = AGENT_MODES.find((m) => m.value === mode) ?? AGENT_MODES[1];

  return (
    <div className="flex flex-col h-full bg-zinc-900 border-l border-zinc-800">
      {/* Approval Dialog */}
      {pendingApproval && (
        <ApprovalDialog
          toolCall={{
            id: pendingApproval.toolCallId,
            name: pendingApproval.toolName,
            arguments: pendingApproval.arguments,
            riskLevel: pendingApproval.riskLevel,
          }}
          onApprove={handleApprove}
          onReject={handleReject}
          open={!!pendingApproval}
          onClose={handleReject}
        />
      )}
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-200">智能助手</h2>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-zinc-500 text-sm mt-8">
            <p>暂无消息。</p>
            <p className="mt-1">
              描述您想要做的事情，智能助手将为您提供帮助。
            </p>
          </div>
        )}
        {messages.map((msg) =>
          msg.role === 'tool' && msg.toolResult ? (
            <ToolCallCard key={msg.id} message={msg} />
          ) : (
            <AgentMessageItem key={msg.id} message={msg} />
          ),
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="p-3 border-t border-zinc-800">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            activeSessionId
              ? '描述您想要做的事情...'
              : '请先连接到服务器...'
          }
          disabled={!activeSessionId}
          rows={2}
          className="w-full resize-none rounded bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
        />

        {/* Action row: mode drawer (left) + send/stop (right) */}
        <div className="flex items-center justify-between gap-2 mt-2">
          {/* Mode drawer trigger */}
          <div className="relative" ref={drawerRef}>
            <button
              type="button"
              onClick={() => setModeDrawerOpen((v) => !v)}
              className={`
                flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium border transition-colors
                ${
                  modeDrawerOpen
                    ? 'bg-zinc-700 border-zinc-600 text-zinc-100'
                    : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100'
                }
              `}
              title={currentModeInfo.description}
              aria-haspopup="listbox"
              aria-expanded={modeDrawerOpen}
            >
              <span className="text-zinc-500">模式</span>
              <span className="font-semibold tracking-wider">
                {currentModeInfo.label}
              </span>
              <svg
                className={`w-3 h-3 transition-transform ${
                  modeDrawerOpen ? 'rotate-180' : ''
                }`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 15l7-7 7 7"
                />
              </svg>
            </button>

            {modeDrawerOpen && (
              <div
                role="listbox"
                className="absolute bottom-full left-0 mb-2 w-64 rounded-lg border border-zinc-700 bg-zinc-800 shadow-2xl py-1 z-30"
              >
                {AGENT_MODES.map((m) => {
                  const active = m.value === mode;
                  return (
                    <button
                      key={m.value}
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        setMode(m.value as AgentMode);
                        setModeDrawerOpen(false);
                      }}
                      className={`
                        w-full text-left px-3 py-2 transition-colors
                        ${
                          active
                            ? 'bg-indigo-600/20 border-l-2 border-indigo-500'
                            : 'hover:bg-zinc-700 border-l-2 border-transparent'
                        }
                      `}
                    >
                      <div className="flex items-center justify-between">
                        <span
                          className={`text-sm font-bold tracking-wider ${
                            active ? 'text-indigo-300' : 'text-zinc-200'
                          }`}
                        >
                          {m.label}
                        </span>
                        {active && (
                          <span className="text-xs text-indigo-400">已选</span>
                        )}
                      </div>
                      <p className="text-xs text-zinc-400 mt-0.5">
                        {m.description}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Send / Stop buttons */}
          <div className="flex gap-2">
            {isRunning && (
              <Button variant="danger" size="sm" onClick={handleStop}>
                停止
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handleSend}
              disabled={!input.trim() || !activeSessionId || isRunning}
            >
              发送
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
