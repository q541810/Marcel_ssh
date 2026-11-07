import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  AGENT_MAX_TOOL_ROUNDS_MAX,
  AGENT_MAX_TOOL_ROUNDS_MIN,
} from '@/lib/constants';
import { PROTECTED_PATHS_RULE, modifiedRuleCount } from '@/lib/riskRules';
import { useRiskRuleCatalog } from '@/hooks/useRiskRuleCatalog';
import { useApprovableTools } from '@/hooks/useApprovableTools';
import { useCommandCheck } from '@/hooks/useCommandCheck';
import { useRiskRuleFocusStore } from '@/stores/riskRuleFocusStore';
import { ApprovalOverview } from '@/components/settings/ApprovalOverview';
import { CommandCheckResultCard } from '@/components/settings/CommandCheckResultCard';
import { CustomRiskRulesEditor } from '@/components/settings/CustomRiskRulesEditor';
import { ProtectedPathsEditor } from '@/components/settings/ProtectedPathsEditor';
import { flashCustomRule, scrollToCustomRules } from '@/lib/riskRuleNav';
import { ToolApprovalEditor } from '@/components/settings/ToolApprovalEditor';
import Toggle from '@/components/ui/Toggle';
import { useSettingsActions } from '@/components/settings/SettingsActionsContext';
import { ModelApprovalPanel } from '@/components/settings/ModelApprovalPanel';
import Reveal from '@/components/ui/Reveal';
import { emptyRegistry, modelFullLabel, modelLabel } from '@/lib/llmRegistry';
import MobileSheet from '../ui/MobileSheet';
import { MobileSettingRow } from './MobileSettingRow';

const inputClass =
  'w-full rounded-lg border border-edge bg-surface-raised px-3 py-2.5 font-mono text-body text-fg outline-none placeholder:text-fg-tertiary focus:border-indigo-500 disabled:opacity-40';

/**
 * Agent 页（手机）：安全与审批 → 用户附加指令 → 执行限制，与桌面同序。
 * 三段在桌面是三张卡，这里用小标题分段。
 */
export function MobileAgentPolicySection() {
  const { settings, update } = useSettingsActions();
  const agent = settings.agentModeSettings;

  const updateAgent = (patch: Partial<typeof agent>) => {
    update({ agentModeSettings: { ...agent, ...patch } });
  };

  const [approvalModelPickerOpen, setApprovalModelPickerOpen] = useState(false);

  const riskOverrides = settings.riskRuleOverrides ?? {};
  const customRules = settings.customRiskRules ?? [];
  const customPaths = settings.customProtectedPaths ?? [];
  const { catalog } = useRiskRuleCatalog();
  const approvableTools = useApprovableTools();
  const openPage = useRiskRuleFocusStore((s) => s.openPage);
  const focusRule = useRiskRuleFocusStore((s) => s.focus);
  const modifiedCount = modifiedRuleCount(riskOverrides);
  const check = useCommandCheck();
  const modelApprovalOn = agent.enableModelCommandApproval ?? false;

  // 命中的是自定义规则 → 就在本页，滚过去；内置规则 → 进二级页并落到那一条。
  const jumpToRule = (ruleId: string) => {
    if (customRules.some((c) => c.id === ruleId)) flashCustomRule(ruleId);
    else focusRule(ruleId);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="mb-1 px-1 text-meta font-medium text-fg-tertiary">
        安全与审批
      </div>
      {/* 什么时候问你：总览表 + 命令确认方式 + Plan / Auto 开关（与桌面共用） */}
      <div className="rounded-xl border border-edge-subtle bg-surface px-3 py-3">
        <ApprovalOverview agent={agent} onChange={updateAgent} compact />
      </div>

      {/* 测试命令 */}
      <MobileSettingRow label="测试命令" description="输入一条命令，看它命中哪条规则、三个模式下各会怎样">
        <div className="mt-2 space-y-2">
          <input
            type="text"
            value={check.command}
            onChange={(e) => check.setCommand(e.target.value)}
            placeholder="例如：rm -rf /tmp/test"
            aria-label="测试命令"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={inputClass}
          />
          {check.error && <p className="text-meta text-red-400">{check.error}</p>}
          {check.results && (
            <CommandCheckResultCard
              results={check.results}
              onJump={jumpToRule}
              compact
              modelApprovalOn={modelApprovalOn}
            />
          )}
        </div>
      </MobileSettingRow>

      {/* 自定义规则 */}
      <MobileSettingRow label="自定义规则" description="命令命中就按所选档位处理，多条命中取最严">
        <div className="mt-2">
          <CustomRiskRulesEditor
            rules={customRules}
            onChange={(next) => update({ customRiskRules: next })}
            reasonTemplate={catalog?.customRule}
            compact
          />
        </div>
      </MobileSettingRow>

      {/* 受保护路径 */}
      <MobileSettingRow
        label="受保护路径"
        description="在这些路径下写入会触发审批"
      >
        <div className="mt-2">
          <ProtectedPathsEditor
            rule={catalog?.rules.find((r) => r.id === PROTECTED_PATHS_RULE) ?? null}
            overrides={riskOverrides}
            customPaths={customPaths}
            onChange={(patch) => update(patch)}
            compact
          />
        </div>
      </MobileSettingRow>

      {/* 需要审批的工具 */}
      <MobileSettingRow
        label="需要审批的工具"
        description="这些工具执行前按所选档位处理；命令由规则决定"
      >
        <div className="mt-2">
          <ToolApprovalEditor
            levels={agent.toolApprovalLevels ?? {}}
            onChange={(next) => updateAgent({ toolApprovalLevels: next })}
            onOpenCommandRules={scrollToCustomRules}
            available={approvableTools}
            compact
          />
        </div>
      </MobileSettingRow>

      {/* 内置风险规则：二级页入口 */}
      <button
        type="button"
        onClick={openPage}
        className="flex items-center gap-3 rounded-xl border border-edge-subtle bg-surface px-3 py-3 text-left pressable"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-body font-medium text-fg">内置风险规则</span>
          <span className="mt-0.5 block text-meta leading-relaxed text-fg-tertiary">
            rm -rf /、pkill、curl | sh 等 {catalog?.rules.length ?? ''} 条
          </span>
        </span>
        {modifiedCount > 0 && (
          <span className="flex-shrink-0 rounded-full border border-indigo-700/50 bg-indigo-500/10 px-2 py-px text-meta text-indigo-200">
            已改 {modifiedCount}
          </span>
        )}
        <ChevronRight className="h-4 w-4 flex-shrink-0 text-fg-disabled" />
      </button>

      {/* 执行前模型审批：开关 + 展开后的引擎卡与表单（与桌面共用 ModelApprovalPanel） */}
      <MobileSettingRow
        label="执行前模型审批"
        description="规则之后的第二道关：规则没拦的 bash 命令，再让模型判断放行、转人工或阻止"
        trailing={
          <Toggle
            checked={modelApprovalOn}
            onChange={(checked) =>
              updateAgent({ enableModelCommandApproval: checked })
            }
          />
        }
      >
        <Reveal show={modelApprovalOn}>
          <div className="mt-3 border-t border-edge-subtle pt-3">
            <ModelApprovalPanel
              agent={agent}
              onChange={updateAgent}
              compact
              modelPicker={
                <button
                  type="button"
                  onClick={() => setApprovalModelPickerOpen(true)}
                  className="flex w-full items-center justify-between gap-2 rounded-lg border border-edge bg-surface-raised px-3 py-2.5 text-body text-fg outline-none active:bg-state-mid"
                >
                  <span className="truncate">
                    {settings.llmRegistry?.slots?.modelApprovalModelId
                      ? modelFullLabel(
                          settings.llmRegistry,
                          settings.llmRegistry.slots.modelApprovalModelId,
                        )
                      : '跟随会话模型'}
                  </span>
                  <ChevronDown className="h-4 w-4 flex-shrink-0 text-fg-tertiary" />
                </button>
              }
            />
          </div>
        </Reveal>
      </MobileSettingRow>

      <div className="mt-2 mb-1 px-1 text-meta font-medium text-fg-tertiary">
        用户附加指令
      </div>
      {/* User system prompt — appended to the agent system prompt (desktop parity) */}
      <MobileSettingRow
        label="用户附加指令"
        description="Agent 调用 LLM 时追加到系统提示词末尾，留空则不注入"
      >
        <textarea
          value={agent.systemPrompt ?? ''}
          onChange={(e) => updateAgent({ systemPrompt: e.target.value })}
          rows={5}
          placeholder="在此输入需要附加到系统提示词中的内容，将在每次 Agent 任务调用 LLM 时生效"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="mt-2 w-full resize-none rounded-lg border border-edge bg-surface-raised px-3 py-2.5 text-body text-fg outline-none placeholder:text-fg-tertiary focus:border-indigo-500"
        />
      </MobileSettingRow>

      <div className="mt-2 mb-1 px-1 text-meta font-medium text-fg-tertiary">
        执行限制
      </div>
      {/* Command timeout */}
      <MobileSettingRow
        label="命令超时时间"
        description="单条命令最长前台等待时间。到点不会被掐断，而是转为后台作业继续运行"
        trailing={
          <span className="w-14 text-right font-mono text-body text-indigo-300">
            {settings.commandTimeoutSecs ?? 120}s
          </span>
        }
      >
        <input
          type="range"
          min={10}
          max={300}
          step={10}
          value={settings.commandTimeoutSecs ?? 120}
          onChange={(e) =>
            update({ commandTimeoutSecs: Number(e.target.value) })
          }
          className="mt-1 h-2 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-indigo-500"
        />
      </MobileSettingRow>

      {/* Max rounds */}
      <MobileSettingRow
        label="最大执行轮数"
        description="单次任务最多执行的工具调用轮数，超限自动停止"
        trailing={
          <span className="w-14 text-right font-mono text-body text-indigo-300">
            {agent.maxToolRounds ?? 500}
          </span>
        }
      >
        <input
          type="range"
          min={AGENT_MAX_TOOL_ROUNDS_MIN}
          max={AGENT_MAX_TOOL_ROUNDS_MAX}
          step={1}
          value={agent.maxToolRounds ?? 500}
          onChange={(e) =>
            updateAgent({ maxToolRounds: Number(e.target.value) })
          }
          className="mt-1 h-2 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-indigo-500"
        />
      </MobileSettingRow>

      {/* 审批模型选择 */}
      <MobileSheet
        open={approvalModelPickerOpen}
        onClose={() => setApprovalModelPickerOpen(false)}
        title="选择审批模型"
      >
        <div className="px-4 pb-4">
          <button
            type="button"
            onClick={() => {
              update({
                llmRegistry: {
                  ...(settings.llmRegistry ?? emptyRegistry()),
                  slots: {
                    ...(settings.llmRegistry?.slots ?? emptyRegistry().slots),
                    modelApprovalModelId: '',
                  },
                },
              });
              setApprovalModelPickerOpen(false);
            }}
            className="flex w-full items-center justify-between rounded-lg px-3 py-3 text-left text-body active:bg-state-soft"
          >
            <span className="text-fg">跟随会话模型</span>
            {!settings.llmRegistry?.slots?.modelApprovalModelId && (
              <span className="text-indigo-400 text-meta">当前</span>
            )}
          </button>
          {/* 按提供商（渠道）分组 */}
          {(settings.llmRegistry?.channels ?? []).map((ch) => {
            const reg = settings.llmRegistry ?? emptyRegistry();
            const channelModels = reg.models.filter((m) => m.channelId === ch.id);
            if (channelModels.length === 0) return null;
            const channelDisabled = !ch.enabled;
            return (
              <div key={ch.id} className="mt-1">
                <div className="flex items-center gap-2 px-3 pb-1 pt-2">
                  <span className="truncate text-caption font-medium uppercase tracking-wide text-fg-tertiary">
                    {ch.name}
                  </span>
                  {channelDisabled && (
                    <span className="flex-shrink-0 rounded bg-zinc-700 px-1 py-0.5 text-caption text-fg-secondary">
                      已禁用
                    </span>
                  )}
                </div>
                <div className="divide-y divide-edge-subtle/70">
                  {channelModels.map((m) => {
                    const selected = settings.llmRegistry?.slots?.modelApprovalModelId === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        disabled={channelDisabled}
                        onClick={() => {
                          const registry = settings.llmRegistry ?? emptyRegistry();
                          update({
                            llmRegistry: {
                              ...registry,
                              slots: { ...registry.slots, modelApprovalModelId: m.id },
                            },
                          });
                          setApprovalModelPickerOpen(false);
                        }}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-3 text-left active:bg-state-soft ${
                          channelDisabled ? "opacity-40" : ""
                        }`}
                      >
                        <span className="min-w-0 truncate text-body text-fg">
                          {modelLabel(m)}
                        </span>
                        {selected && <span className="flex-shrink-0 text-meta text-indigo-400">当前</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {(settings.llmRegistry?.models ?? []).length === 0 && (
            <p className="py-6 text-center text-body text-fg-tertiary">
              还没有可用的模型，请先在「模型服务」中添加
            </p>
          )}
        </div>
      </MobileSheet>
    </div>
  );
}
