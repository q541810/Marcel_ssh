import { useState } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useConnectWithPassword } from '@/hooks/useConnectWithPassword';
import { DEFAULT_PORT } from '@/lib/constants';
import { getErrorMessage } from '@/lib/errors';
import type { ConnectionConfig } from '@/lib/types';

interface ParsedTarget {
  host: string;
  port: number;
  username: string;
}

export default function QuickConnect() {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const connect = useSessionStore((s) => s.connect);
  const { prompt: promptPassword, Prompt: PasswordPromptEl } = useConnectWithPassword();

  const parseConnectionString = (str: string): ParsedTarget | null => {
    // Format: user@host:port or user@host
    const trimmed = str.trim();
    if (!trimmed) return null;

    const match = trimmed.match(/^([^@]+)@([^:]+)(?::(\d+))?$/);
    if (!match) return null;

    const [, username, host, portStr] = match;
    const port = portStr ? parseInt(portStr, 10) : DEFAULT_PORT;

    if (port < 1 || port > 65535) return null;
    return { host, port, username };
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const target = parseConnectionString(input);
    if (!target) {
      setError('格式：user@host 或 user@host:port');
      return;
    }
    promptPassword({
      title: 'SSH 认证',
      description: `连接到 ${target.username}@${target.host}:${target.port}`,
      onSubmit: async (password) => {
        const config: ConnectionConfig = {
          ...target,
          authMethod: { type: 'Password', password },
        };
        try {
          await connect(config);
          setInput('');
        } catch (err) {
          setError(getErrorMessage(err));
        }
      },
    });
  };

  return (
    <>
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <div className="flex-1 relative">
          <input
            type="text"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError('');
            }}
            placeholder="user@host:port"
            className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
          />
          {error && (
            <div className="absolute top-full left-0 mt-1 text-xs text-red-400 z-10 max-w-md truncate">
              {error}
            </div>
          )}
        </div>
        <button
          type="submit"
          disabled={!input.trim()}
          className="px-3 py-1.5 rounded-lg bg-indigo-600 text-sm text-white font-medium hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          连接
        </button>
      </form>

      {PasswordPromptEl}
    </>
  );
}
