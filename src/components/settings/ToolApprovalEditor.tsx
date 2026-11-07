import { useState } from 'react';
import { ChevronRight, X } from 'lucide-react';
import {
  COMMAND_TOOL,
  TOOL_LEVELS,
  addTool,
  addableGroups,
  listedTools,
  removeTool,
  setToolLevel,
  toolInfo,
  type ToolApprovalLevels,
} from '@/lib/toolApproval';
import { RULE_LEVEL_DOT, RULE_LEVEL_LABELS } from '@/lib/riskRules';
import { LevelSelect } from './RiskLevelSelect';

/**
 * 「需要审批的工具」（桌面与手机共用）：点名哪些内置工具执行前要审批，并给每个工具选档位。
 *
 * 呈现与「自定义规则」「允许的命令」同一套小标签：一排标签（工具名 + 档位色点），一行就能扫完，
 * 点哪个才在下面展开它的编辑区（档位、不再审批），同一时间只开一个。可选的工具有二十来个，
 * 所以「添加工具」点开是按用途分组的清单，而不是铺开一长排按钮。
 *
 * 第一个标签永远是「执行命令」：它不用在这里选档位 —— 命令要不要问你完全由命令确认方式和
 * 命令规则决定，这个标签只负责把它摆出来，并带用户去看那些规则（`onOpenCommandRules`）。
 * 其余工具想不再审批，就在编辑区点「不再审批」；之后随时能从「添加工具」里加回来。
 * 档位含义与命令风险规则是同一套，所以下拉也是同一个组件。
 *
 * `available` 是后端给的可选工具清单；没给（还没取回、或取失败）就用前端认识的那些。
 */
export function ToolApprovalEditor({
  levels,
  onChange,
  onOpenCommandRules,
  available,
  compact,
}: {
  levels: ToolApprovalLevels;
  onChange: (next: ToolApprovalLevels) => void;
  /** 点「执行命令」标签：调用方负责滚到命令规则那一块。 */
  onOpenCommandRules?: () => void;
  /** 后端的可选工具清单（`agent_list_approvable_tools`）。 */
  available?: readonly string[] | null;
  compact?: boolean;
}) {
  // 正在编辑的那个工具 / 是否展开了「添加工具」清单（两者互斥，同一时间只开一块面板）。
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const listed = listedTools(levels);
  const groups = addableGroups(levels, available ?? undefined);
  // 正在编辑的工具被别处移掉了（例如配置被外部改了），就当没有打开。
  const editingName = editing !== null && listed.includes(editing) ? editing : null;
  const chipHeight = compact ? 'min-h-10 text-body' : 'min-h-8 text-meta';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onOpenCommandRules}
          title="命令要不要问你，由命令确认方式和命令规则决定，点这里去看"
          aria-label={`${COMMAND_TOOL.label}：按命令规则`}
          className={`inline-flex max-w-full items-center gap-2 rounded-lg border border-edge bg-surface-raised px-3 text-fg-secondary transition-colors hover:bg-state-mid active:bg-state-mid ${chipHeight}`}
        >
          {COMMAND_TOOL.label}
          <ChevronRight className="-mr-1 h-3.5 w-3.5 flex-shrink-0 text-fg-tertiary" />
        </button>
        {listed.map((name) => {
          const info = toolInfo(name);
          const level = levels[name];
          const selected = editingName === name;
          return (
            <button
              key={name}
              type="button"
              onClick={() => {
                setAdding(false);
                setEditing((cur) => (cur === name ? null : name));
              }}
              aria-expanded={selected}
              title={`${info.label}（${name}）：${RULE_LEVEL_LABELS[level]}`}
              className={`inline-flex max-w-full items-center gap-2 rounded-lg border px-3 transition-colors ${chipHeight} ${
                selected
                  ? 'border-indigo-500 bg-indigo-500/10 text-fg'
                  : 'border-edge bg-surface-raised text-fg hover:bg-state-mid active:bg-state-mid'
              }`}
            >
              <span
                className={`h-2 w-2 flex-shrink-0 rounded-full ${RULE_LEVEL_DOT[level]}`}
              />
              <span className="truncate">{info.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            setAdding((v) => !v);
          }}
          aria-expanded={adding}
          className={`inline-flex items-center gap-2 rounded-lg border border-dashed px-3 transition-colors ${chipHeight} ${
            adding
              ? 'border-indigo-500 text-indigo-300'
              : 'border-edge-strong text-fg-secondary hover:border-indigo-500 hover:text-indigo-300 active:text-indigo-300'
          }`}
        >
          + 添加工具
        </button>
      </div>

      <p className="text-meta leading-relaxed text-fg-tertiary">
        命令确认方式选了「每条都确认」时，自带审批的工具（如编辑文件、上传下载）即使把它从这里移掉，仍会问你。
      </p>

      {editingName && (
        <ToolEditor
          // 换一个工具时重建，免得上一个的状态串过来。
          key={editingName}
          name={editingName}
          levels={levels}
          compact={compact}
          onChange={(next) => onChange(next)}
          onRemoved={() => setEditing(null)}
        />
      )}

      {adding && (
        <div className="space-y-2 rounded-xl border border-edge bg-surface-sunken/30 p-3">
          {groups.length === 0 && (
            <p className="text-meta text-fg-tertiary">没有更多可添加的工具了</p>
          )}
          {groups.map((g) => (
            <div key={g.id} className="flex items-start gap-2">
              <span
                className={`flex-shrink-0 text-meta text-fg-tertiary ${
                  compact ? 'w-14 pt-3' : 'w-14 pt-2'
                }`}
              >
                {g.label}
              </span>
              <div className="flex min-w-0 flex-1 flex-wrap gap-2">
                {g.tools.map((t) => (
                  <button
                    key={t.name}
                    type="button"
                    onClick={() => {
                      onChange(addTool(levels, t.name));
                      setAdding(false);
                      // 加完直接展开它：默认「请求审批」，不合意当场就能改。
                      setEditing(t.name);
                    }}
                    title={t.name}
                    className={`rounded-lg border border-dashed border-edge-strong px-3 text-fg-secondary transition-colors hover:border-indigo-500 hover:text-indigo-300 active:text-indigo-300 ${
                      compact ? 'min-h-10 text-body' : 'min-h-7 text-meta'
                    }`}
                  >
                    + {t.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 点开某个工具后的编辑区：档位、不再审批。 */
function ToolEditor({
  name,
  levels,
  compact,
  onChange,
  onRemoved,
}: {
  name: string;
  levels: ToolApprovalLevels;
  compact?: boolean;
  onChange: (next: ToolApprovalLevels) => void;
  onRemoved: () => void;
}) {
  const info = toolInfo(name);
  return (
    <div className="space-y-2 rounded-xl border border-edge bg-surface-sunken/30 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* 手机上控件占的宽度大，标题和控件同一行会把名字挤成省略号：标题独占一行。 */}
        <span
          className={`truncate text-body text-fg ${
            compact ? 'basis-full' : 'min-w-0 flex-1'
          }`}
        >
          {info.label}
          <span className="ml-2 font-mono text-caption text-fg-tertiary">
            {name}
          </span>
        </span>
        <span
          className={
            compact
              ? 'flex w-full items-center justify-between gap-2'
              : 'ml-auto flex items-center gap-2'
          }
        >
          <LevelSelect
            ariaLabel={`${info.label}：审批档位`}
            value={levels[name]}
            options={TOOL_LEVELS}
            defaultLevel="Approval"
            compact={compact}
            onChange={(level) => onChange(setToolLevel(levels, name, level))}
          />
          <button
            type="button"
            onClick={() => {
              onChange(removeTool(levels, name));
              onRemoved();
            }}
            className={`inline-flex flex-shrink-0 items-center gap-2 rounded-lg border border-edge text-fg-secondary transition-colors hover:border-red-700/50 hover:bg-red-500/10 hover:text-red-300 active:bg-red-500/10 active:text-red-300 ${
              compact ? 'min-h-11 px-4 text-body' : 'min-h-9 px-3 text-body'
            }`}
            aria-label={`${info.label}不再审批`}
            title="这个工具不再额外审批，之后可以从「添加工具」加回来"
          >
            <X className="h-4 w-4" />
            不再审批
          </button>
        </span>
      </div>
      {info.alsoLocal && (
        <p className="text-meta leading-relaxed text-fg-tertiary">
          本机子 agent 里的同名工具共用这一条。
        </p>
      )}
    </div>
  );
}
