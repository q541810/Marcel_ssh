import { useState } from 'react';
import { useApprovalOverview } from '@/hooks/useApprovalOverview';
import {
  CHECK_MODES,
  RULE_LEVEL_LABELS,
  type CheckMode,
} from '@/lib/riskRules';
import type {
  AgentModeSettings,
  ApprovalOverview as Overview,
  Disposition,
  OverviewCell,
  OverviewRow,
  OverviewVerdict,
} from '@/lib/types';
import { useSettingsStore } from '@/stores/settingsStore';
import Button from '@/components/ui/Button';
import SegmentedControl from '@/components/ui/SegmentedControl';
import Toggle from '@/components/ui/Toggle';

/**
 * 「什么时候问你」总览（桌面与手机共用）：审批设置页最上面的一张表。
 *
 * 一句话讲清整套逻辑：**先按规则给每个操作定一档，再看当前模式决定问不问你**。
 * 行是档位（拒绝 / 强制审批 / 请求审批 / 没命中任何规则），列是模式（Agent / Plan / Auto），
 * 格子是「问你 / 直接执行 / 拒绝」。三个只影响这张表的设置都放在表的对应位置：
 *   - Plan 的开关 = 「Plan 模式也需要审批」（整列跟 Agent 一样）
 *   - Auto 的开关 = 「Auto 模式强制审批」（只让 Auto × 强制审批这一格变成「问你」）
 *   - 表下面的「没命中任何规则的命令」= 命令确认方式（每条都确认 / 按规则 / 白名单）
 *
 * 桌面是一张四列的真表格（「常用」模式整列铺底色，开关在列头）；手机一行只有 375px，四列塞不下，
 * 所以手机另有版式：同一张表只留文字（短词、无格框），开关单独成两行放在表下面。
 * 两种版式读的是同一份后端结果、拨的是同一组字段，只有排版不同。
 *
 * 格子的值全部来自后端（`useApprovalOverview`），这里只负责呈现，不推导任何结论。
 */

const VERDICT_LABEL: Record<OverviewVerdict, string> = {
  ask: '问你',
  run: '直接执行',
  deny: '拒绝',
};

/** 手机上一个格子要并排两句时用的短说法（「直接执行」太长会折行）。 */
const VERDICT_SHORT: Record<OverviewVerdict, string> = {
  ask: '问你',
  run: '执行',
  deny: '拒绝',
};

/**
 * 整张表只用字色区分结论、不铺色块：「问你」琥珀、「拒绝」红，「直接执行」退成灰，
 * 要你介入的格子自然跳出来；颜色只表达这一层含义，行标题、列头、底色都保持中性。
 */
const VERDICT_TONE: Record<OverviewVerdict, string> = {
  ask: 'text-amber-300',
  run: 'text-fg-tertiary',
  deny: 'text-red-300',
};

/** 每一行的名字与一句话含义。「没命中」那行没有档位名，用大白话。 */
const ROW_INFO: Record<Disposition, { label: string; hint: string }> = {
  Deny: {
    label: RULE_LEVEL_LABELS.Deny,
    hint: '不执行，让模型换写法',
  },
  ForceApproval: {
    label: RULE_LEVEL_LABELS.ForceApproval,
    hint: '如系统级命令、受保护路径',
  },
  Approval: {
    label: RULE_LEVEL_LABELS.Approval,
    hint: '如 sudo 提权、你自己加的规则',
  },
  Allow: {
    label: '没命中任何规则',
    hint: '如 ls、cat 这类',
  },
};

const CONFIRM_MODE_OPTIONS = [
  { value: 'each', label: '每条都确认', title: '每条命令都问你' },
  { value: 'denylist', label: '按规则', title: '没命中规则的命令直接执行' },
  { value: 'allowlist', label: '白名单', title: '名单里的命令直接执行，其余都问' },
] as const;

/** 桌面列头开关：开关和说明同一行，不占两行高度。样式写在外层而不是改 Toggle，免得动到别处的开关。 */
const HEADER_TOGGLE =
  '[&>label]:gap-2 [&>label>span:last-child]:whitespace-nowrap [&>label>span:last-child]:text-meta [&>label>span:last-child]:text-fg-secondary';

/** 「常用」模式那一整列铺一层中性淡底，像表格的选中列。 */
const USUAL_BAND = 'bg-surface-raised/40';

/** 手机上的命令确认方式：三个选项撑满一行、按钮够手指点（共用的分段控件是为桌面做的小号）。 */
export const FULL_WIDTH_SEGMENTS =
  '[&>div]:flex [&>div]:w-full [&_button]:min-h-10 [&_button]:flex-1 [&_button]:text-body';

const PLAN_TOGGLE_HINT = 'Plan 这一列同时管 Agent 派出去的只读调研子任务';

function cellOf(row: OverviewRow, mode: CheckMode): OverviewCell {
  return row[mode];
}

/** 白名单下「没命中」一行名单内外结论不同时，返回名单内的结论；否则 null。 */
function listedVerdict(cell: OverviewCell): OverviewVerdict | null {
  return cell.listed && cell.listed !== cell.verdict ? cell.listed : null;
}

function Pill({ verdict }: { verdict: OverviewVerdict }) {
  return (
    <span className={`whitespace-nowrap text-body font-medium ${VERDICT_TONE[verdict]}`}>
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

function Cell({ cell }: { cell: OverviewCell }) {
  const listed = listedVerdict(cell);
  if (listed) {
    return (
      <div className="flex flex-col items-start gap-1">
        <span className="flex items-center gap-1">
          <span className="text-caption text-fg-tertiary">名单外</span>
          <Pill verdict={cell.verdict} />
        </span>
        <span className="flex items-center gap-1">
          <span className="text-caption text-fg-tertiary">名单内</span>
          <Pill verdict={listed} />
        </span>
      </div>
    );
  }
  return <Pill verdict={cell.verdict} />;
}

/** 桌面：四列真表格。 */
function DesktopTable({
  overview,
  usualMode,
  agent,
  onChange,
}: {
  overview: Overview | null;
  usualMode: string;
  agent: AgentModeSettings;
  onChange: (patch: Partial<AgentModeSettings>) => void;
}) {
  // 列之间不留缝（间距放进单元格的内边距），这样「常用」那一列的底色才是连成一条的。
  const grid = 'grid grid-cols-[minmax(0,1.3fr)_repeat(3,minmax(0,1fr))]';
  const lastRowIndex = (overview?.rows.length ?? 0) - 1;

  return (
    <div>
      {/* 列头：模式名 + 属于这一列的开关 */}
      <div className={grid}>
        <span />
        {CHECK_MODES.map(({ mode, label }) => {
          const usual = usualMode === mode;
          return (
            <div
              key={mode}
              className={`min-w-0 space-y-2 rounded-t-xl px-3 pt-3 pb-3 ${
                usual ? USUAL_BAND : ''
              }`}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-body font-semibold text-fg">{label}</span>
                {usual && (
                  <span
                    className="whitespace-nowrap rounded border border-edge px-1 text-caption text-fg-secondary"
                    title="你默认使用的模式"
                  >
                    常用
                  </span>
                )}
              </div>
              {mode === 'plan' && (
                <div className={HEADER_TOGGLE} title={PLAN_TOGGLE_HINT}>
                  <Toggle
                    size="sm"
                    checked={agent.planModeRequiresApproval ?? false}
                    onChange={(v) => onChange({ planModeRequiresApproval: v })}
                    label="也要审批"
                  />
                </div>
              )}
              {mode === 'auto' && (
                <div className={HEADER_TOGGLE}>
                  <Toggle
                    size="sm"
                    checked={agent.autoModeForceApproval ?? false}
                    onChange={(v) => onChange({ autoModeForceApproval: v })}
                    label="强制审批仍问我"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 表体：后端没取回来就不画（不拿猜的值顶上） */}
      {overview ? (
        overview.rows.map((row, i) => {
          const info = ROW_INFO[row.level];
          return (
            <div key={row.level} className={`${grid} border-t border-edge-subtle`}>
              <div className="min-w-0 py-4 pr-3">
                <span className="text-body font-medium text-fg">{info.label}</span>
                <p className="mt-1 text-meta leading-snug text-fg-tertiary">{info.hint}</p>
              </div>
              {CHECK_MODES.map(({ mode }) => (
                <div
                  key={mode}
                  className={`flex min-w-0 items-center px-3 py-4 ${
                    usualMode === mode ? USUAL_BAND : ''
                  } ${i === lastRowIndex && usualMode === mode ? 'rounded-b-xl' : ''}`}
                >
                  <Cell cell={cellOf(row, mode)} />
                </div>
              ))}
            </div>
          );
        })
      ) : (
        <p className="border-t border-edge-subtle py-4 text-meta text-fg-tertiary">正在读取…</p>
      )}
    </div>
  );
}

/**
 * 手机：同一张 4 行 × 3 列的表，但只剩文字 —— 没有格框、结论用短词（问你 / 执行 / 拒绝）、
 * 行标题列放窄，375px 刚好放得下；常用模式那一列铺淡底。开关不塞进窄窄的列头，而是单独成两行，
 * 只写一行标题（带上模式名），整块比逐档位铺卡矮六成。
 */
function MobileMatrix({
  overview,
  usualMode,
  agent,
  onChange,
}: {
  overview: Overview | null;
  usualMode: string;
  agent: AgentModeSettings;
  onChange: (patch: Partial<AgentModeSettings>) => void;
}) {
  const grid = 'grid grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,1fr))]';
  const lastRowIndex = (overview?.rows.length ?? 0) - 1;

  return (
    <div className="space-y-3">
      <div>
        <div className={grid}>
          <span />
          {CHECK_MODES.map(({ mode, label }) => (
            <div
              key={mode}
              className={`rounded-t-lg px-1 pt-2 pb-2 text-center ${
                usualMode === mode ? USUAL_BAND : ''
              }`}
            >
              <span className="text-meta font-semibold text-fg">{label}</span>
              {usualMode === mode && (
                <span className="block text-caption leading-tight text-fg-tertiary">常用</span>
              )}
            </div>
          ))}
        </div>

        {overview ? (
          overview.rows.map((row, i) => {
            const info = ROW_INFO[row.level];
            return (
              <div key={row.level} className={`${grid} border-t border-edge-subtle`}>
                <div className="min-w-0 py-3 pr-2">
                  <p className="text-body font-medium text-fg">{info.label}</p>
                  <p className="text-caption leading-tight text-fg-tertiary">{info.hint}</p>
                </div>
                {CHECK_MODES.map(({ mode }) => {
                  const cell = cellOf(row, mode);
                  const listed = listedVerdict(cell);
                  return (
                    <div
                      key={mode}
                      className={`flex min-w-0 items-center justify-center px-1 ${
                        usualMode === mode ? USUAL_BAND : ''
                      } ${i === lastRowIndex && usualMode === mode ? 'rounded-b-lg' : ''}`}
                    >
                      {listed ? (
                        <span className="text-center text-caption leading-snug">
                          <span className={`block ${VERDICT_TONE[cell.verdict]}`}>
                            名单外{VERDICT_SHORT[cell.verdict]}
                          </span>
                          <span className={`block ${VERDICT_TONE[listed]}`}>
                            名单内{VERDICT_SHORT[listed]}
                          </span>
                        </span>
                      ) : (
                        <span className={`text-body font-medium ${VERDICT_TONE[cell.verdict]}`}>
                          {VERDICT_SHORT[cell.verdict]}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })
        ) : (
          <p className="border-t border-edge-subtle py-3 text-meta text-fg-tertiary">正在读取…</p>
        )}
      </div>

      <div className="rounded-xl bg-surface-raised/50">
        <MobileSwitchRow
          title="Plan：也要审批"
          checked={agent.planModeRequiresApproval ?? false}
          onChange={(v) => onChange({ planModeRequiresApproval: v })}
        />
        <MobileSwitchRow
          title="Auto：强制审批仍问我"
          checked={agent.autoModeForceApproval ?? false}
          onChange={(v) => onChange({ autoModeForceApproval: v })}
          divided
        />
      </div>
    </div>
  );
}

function MobileSwitchRow({
  title,
  checked,
  onChange,
  divided,
}: {
  title: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  divided?: boolean;
}) {
  return (
    <div
      className={`flex min-h-11 items-center justify-between gap-3 px-3 py-2 ${
        divided ? 'border-t border-edge-subtle' : ''
      }`}
    >
      <span className="text-body text-fg">{title}</span>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

export function ApprovalOverview({
  agent,
  onChange,
  compact,
}: {
  agent: AgentModeSettings;
  onChange: (patch: Partial<AgentModeSettings>) => void;
  compact?: boolean;
}) {
  const overview = useApprovalOverview(agent);
  const usualMode = useSettingsStore((s) => s.settings.defaultAgentMode);
  const [newCommand, setNewCommand] = useState('');

  const confirmMode = agent.confirmEachCommand ? 'each' : agent.listMode;
  const inputClass = `flex-1 rounded-lg bg-surface-raised border border-edge px-3 font-mono text-fg placeholder:text-fg-tertiary focus:outline-none focus:border-indigo-500 ${
    compact ? 'py-3 text-body' : 'py-2 text-body'
  }`;

  const addCommand = () => {
    const v = newCommand.trim();
    if (!v) return;
    if (!agent.allowCommands.includes(v)) {
      onChange({ allowCommands: [...agent.allowCommands, v] });
    }
    setNewCommand('');
  };

  // 请求审批与强制审批两行是否一模一样 —— 是的话明说，免得用户以为这两档有什么我没看懂的区别。
  const forceRow = overview?.rows.find((r) => r.level === 'ForceApproval');
  const approvalRow = overview?.rows.find((r) => r.level === 'Approval');
  const autoDiffers =
    forceRow && approvalRow && forceRow.auto.verdict !== approvalRow.auto.verdict;

  return (
    <div className={compact ? 'space-y-3' : 'space-y-4'}>
      <div>
        <p className="text-body font-medium text-fg">什么时候问你</p>
        <p className="mt-1 text-meta leading-relaxed text-fg-tertiary">
          {compact
            ? '三种模式遇到各类操作时，问你还是直接执行。'
            : '先按规则给每个操作定一档，再看当前模式决定问不问你。拨动开关，表会立刻跟着变。'}
        </p>
      </div>

      {compact ? (
        <MobileMatrix
          overview={overview}
          usualMode={usualMode}
          agent={agent}
          onChange={onChange}
        />
      ) : (
        <DesktopTable
          overview={overview}
          usualMode={usualMode}
          agent={agent}
          onChange={onChange}
        />
      )}

      {overview && !compact && (
        <p className="rounded-lg bg-surface-raised/50 px-3 py-2 text-meta leading-relaxed text-fg-secondary">
          {autoDiffers
            ? '现在 Auto 下只有「强制审批」会问你，「请求审批」不问。'
            : '「请求审批」和「强制审批」目前表现完全一样，区别只在 Auto 的开关：打开后，Auto 下「强制审批」仍会问你，「请求审批」依然不问。'}
        </p>
      )}

      {/* 表里「没命中任何规则」那一行怎么处理 = 命令确认方式 */}
      <div
        className={`flex gap-x-6 gap-y-3 border-t border-edge-subtle pt-4 ${
          compact ? 'flex-col' : 'flex-row items-center justify-between'
        }`}
      >
        <div className="min-w-0">
          <p className="text-body font-medium text-fg">没命中任何规则的命令</p>
          <p className="mt-1 text-meta leading-relaxed text-fg-tertiary">
            {compact
              ? agent.confirmEachCommand
                ? '也包括编辑文件、上传下载、MCP 等工具。Auto 下不问。'
                : '只影响表里最后一行。Auto 下不问。'
              : agent.confirmEachCommand
                ? '每条都问你，也包括编辑文件、上传下载、MCP 等没单独设档位的工具。只在 Agent（和开了审批的 Plan）下生效。'
                : '只影响表里最后一行，且只在 Agent（和开了审批的 Plan）下生效；Auto 一律不问。'}
          </p>
        </div>
        <div className={compact ? FULL_WIDTH_SEGMENTS : 'flex-shrink-0'}>
          <SegmentedControl
            ariaLabel="命令确认方式"
            value={confirmMode}
            onChange={(v) =>
              onChange(
                v === 'each'
                  ? { confirmEachCommand: true }
                  : { confirmEachCommand: false, listMode: v },
              )
            }
            options={CONFIRM_MODE_OPTIONS}
          />
        </div>
      </div>

      {!agent.confirmEachCommand && agent.listMode === 'allowlist' && (
        <div className="space-y-2">
          <p className="text-meta leading-relaxed text-fg-tertiary">
            {compact
              ? '名单里的命令不再问你，其余都问；命中规则的照旧按规则处理。'
              : '允许的命令：名单里的不再问你，其余都问，按基础命令名匹配（不含路径或参数）。命中上面规则的命令照样按规则处理，不会因为进了名单就放行。'}
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={newCommand}
              onChange={(e) => setNewCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addCommand();
                }
              }}
              placeholder="例如：ls 或 cat"
              aria-label="添加允许的命令"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className={inputClass}
            />
            <Button
              variant="secondary"
              size="md"
              onClick={addCommand}
              disabled={!newCommand.trim()}
            >
              添加
            </Button>
          </div>
          {agent.allowCommands.length === 0 ? (
            <p className="px-1 text-meta italic text-fg-tertiary">列表为空</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {agent.allowCommands.map((cmd) => (
                <span
                  key={cmd}
                  className="inline-flex items-center gap-2 rounded-lg border border-edge bg-surface-raised px-2 py-1 font-mono text-meta text-fg"
                >
                  {cmd}
                  <button
                    type="button"
                    onClick={() =>
                      onChange({
                        allowCommands: agent.allowCommands.filter((c) => c !== cmd),
                      })
                    }
                    className={`text-fg-tertiary transition-colors hover:text-red-400 active:text-red-400 ${
                      compact ? '-my-1 -mr-2 px-3 py-2 text-body leading-none' : ''
                    }`}
                    aria-label={`移除 ${cmd}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
