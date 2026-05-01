import { useState } from 'react';
import type { RiskLevel } from '@/lib/types';
import { RISK_LEVEL_COLORS, RISK_LEVEL_LABELS } from '@/lib/constants';

interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  riskLevel: RiskLevel;
  details: string;
  sessionId: string;
}

interface Props {
  entries: AuditEntry[];
}

export default function AuditLog({ entries }: Props) {
  const [filter, setFilter] = useState<RiskLevel | 'all'>('all');

  const filteredEntries =
    filter === 'all'
      ? entries
      : entries.filter((e) => e.riskLevel === filter);

  const formatTimestamp = (ts: string) => {
    try {
      return new Date(ts).toLocaleString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return ts;
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Filter bar */}
      <div className="flex items-center gap-2 p-2 border-b border-zinc-700">
        <span className="text-xs text-zinc-400">筛选：</span>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as RiskLevel | 'all')}
          className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 focus:outline-none"
        >
          <option value="all">全部</option>
          <option value="readonly">只读</option>
          <option value="low_risk">低风险</option>
          <option value="moderate">中等</option>
          <option value="high_risk">高风险</option>
          <option value="destructive">破坏性</option>
        </select>
      </div>

      {/* Entries list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filteredEntries.length === 0 && (
          <p className="text-sm text-zinc-500 text-center mt-4">
            暂无审计记录。
          </p>
        )}
        {filteredEntries.map((entry) => (
          <div
            key={entry.id}
            className="p-2 rounded bg-zinc-800/50 border border-zinc-700/50 text-xs"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-zinc-500">
                {formatTimestamp(entry.timestamp)}
              </span>
              <span
                className={`px-1.5 py-0.5 rounded text-xs font-medium ${RISK_LEVEL_COLORS[entry.riskLevel]}`}
              >
                {RISK_LEVEL_LABELS[entry.riskLevel]}
              </span>
            </div>
            <p className="text-zinc-200 font-mono">{entry.action}</p>
            {entry.details && (
              <p className="text-zinc-500 mt-0.5">{entry.details}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
