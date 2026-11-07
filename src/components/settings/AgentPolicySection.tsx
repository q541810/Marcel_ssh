import { useMemo, useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  AGENT_MAX_TOOL_ROUNDS_MAX,
  AGENT_MAX_TOOL_ROUNDS_MIN,
} from '@/lib/constants';
import { PROTECTED_PATHS_RULE, modifiedRuleCount } from '@/lib/riskRules';
import { useRiskRuleCatalog } from '@/hooks/useRiskRuleCatalog';
import { useApprovableTools } from '@/hooks/useApprovableTools';
import { useCommandCheck } from '@/hooks/useCommandCheck';
import { flashCustomRule, scrollToCustomRules } from '@/lib/riskRuleNav';
import { useRiskRuleFocusStore } from '@/stores/riskRuleFocusStore';
import { ApprovalOverview } from './ApprovalOverview';
import { ModelApprovalPanel } from './ModelApprovalPanel';
import Reveal from '@/components/ui/Reveal';
import { CommandCheckResultCard } from './CommandCheckResultCard';
import { CustomRiskRulesEditor } from './CustomRiskRulesEditor';
import { ProtectedPathsEditor } from './ProtectedPathsEditor';
import { ToolApprovalEditor } from './ToolApprovalEditor';
import Toggle from '@/components/ui/Toggle';
import Select from '@/components/ui/Select';
import { Card, SettingItem, useSearchRegistry } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';
import { ValidatedInput } from './ValidatedInput';
import { emptyRegistry, modelOptionsByChannel } from '@/lib/llmRegistry';

export { preCheckCustomPath } from '@/lib/riskRules';

export { DEFAULT_APPROVAL_PROMPT_FALLBACK, needsUrlScheme } from './ModelApprovalPanel';

export function AgentPolicySection() {
  const { settings, update } = useSettingsActions();
  const agent = settings.agentModeSettings;

  const updateAgent = (patch: Partial<typeof agent>) => {
    update({ agentModeSettings: { ...agent, ...patch } });
  };

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

  // 「内置风险规则」入口行不走 SettingItem（整行是个按钮），设置搜索靠这里手动登记，
  // 并带上全部规则名，搜规则名也能找到这一行。
  const { register, unregister } = useSearchRegistry();
  const ruleTitles = useMemo(() => catalog?.rules.map((r) => r.title) ?? [], [catalog]);
  const ruleTitlesKey = JSON.stringify(ruleTitles);
  useEffect(() => {
    register({
      id: 'cmd-builtin-rules',
      label: '内置风险规则',
      description: '查看并修改 Agent 执行命令前用的全部内置规则',
      keywords: [
        '规则',
        '风险',
        '拒绝',
        '强制审批',
        '请求审批',
        '放行',
        '豁免',
        'pkill',
        'sudo',
        'systemctl',
        'rm -rf',
        'Windows',
        '命令执行策略',
        'Agent',
        ...ruleTitles,
      ],
      sectionId: 'settings-command-policy',
    });
    return () => unregister('cmd-builtin-rules');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register, unregister, ruleTitlesKey]);

  // 「什么时候问你」总览不走 SettingItem（它是一整块），搜索靠这里登记；原来分散的几个
  // 设置（命令确认方式 / 允许的命令 / Plan 与 Auto 的开关）现在都嵌在表里，搜旧名字仍要能找到。
  useEffect(() => {
    register({
      id: 'cmd-approval-overview',
      label: '什么时候问你',
      description: '命令确认方式、允许的命令、Plan 模式也需要审批、Auto 模式强制审批',
      keywords: [
        'confirm',
        'list',
        'mode',
        'plan',
        'auto',
        'force',
        'approval',
        '命令确认方式',
        '每条都确认',
        '按规则',
        '白名单',
        '黑名单',
        '允许的命令',
        '命令列表',
        'Plan 模式也需要审批',
        'Auto 模式强制审批',
        '强制审批',
        '请求审批',
        '审批',
        '命令执行策略',
        'Agent',
      ],
      sectionId: 'settings-command-policy',
    });
    return () => unregister('cmd-approval-overview');
  }, [register, unregister]);

  return (
    <div className="space-y-6">
      <Card
        id="settings-command-policy"
        title="安全与审批"
        description="控制 Agent 在哪些情况下要先问你、哪些命令直接拒绝"
      >
        <div className="px-6 py-5">
          <ApprovalOverview agent={agent} onChange={updateAgent} />
        </div>
        <SettingItem fullWidth
          id="cmd-test"
          label="测试命令"
          description="输入一条命令，看它命中哪条规则、三个模式下各会怎样"
          sectionId="settings-command-policy"
          keywords={['test', '验证', '命令执行策略', 'Agent']}
        >
          <div className="flex-1 space-y-2 min-w-0 w-80">
            <input
              type="text"
              value={check.command}
              onChange={(e) => check.setCommand(e.target.value)}
              placeholder="例如：rm -rf /tmp/test"
              aria-label="测试命令"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="w-full rounded-lg bg-field border border-edge-strong px-3 py-2 text-body font-mono text-fg placeholder:text-fg-tertiary focus:outline-none focus:border-indigo-500"
            />
            {check.error && <p className="text-meta text-red-400">{check.error}</p>}
            {check.results && (
              <CommandCheckResultCard
                results={check.results}
                onJump={jumpToRule}
                modelApprovalOn={modelApprovalOn}
              />
            )}
          </div>
        </SettingItem>
        <SettingItem fullWidth
          id="cmd-custom-rules"
          label="自定义规则"
          description="命令命中就按所选档位处理，多条命中取最严"
          sectionId="settings-command-policy"
          keywords={['custom', 'rule', '自定义', '规则', '命令执行策略', 'Agent']}
        >
          <div className="flex-1 min-w-0">
            <CustomRiskRulesEditor
              rules={customRules}
              onChange={(next) => update({ customRiskRules: next })}
              reasonTemplate={catalog?.customRule}
            />
          </div>
        </SettingItem>
        <SettingItem fullWidth
          id="cmd-protected-paths"
          label="受保护路径"
          description="在这些路径下写入会触发审批"
          sectionId="settings-command-policy"
          keywords={[
            'protected',
            'paths',
            '受保护',
            '路径',
            'agent',
            '审批',
            '命令执行策略',
          ]}
        >
          <div className="flex-1 min-w-0">
            <ProtectedPathsEditor
              rule={catalog?.rules.find((r) => r.id === PROTECTED_PATHS_RULE) ?? null}
              overrides={riskOverrides}
              customPaths={customPaths}
              onChange={(patch) => update(patch)}
            />
          </div>
        </SettingItem>
        <SettingItem fullWidth
          id="cmd-tool-approval"
          label="需要审批的工具"
          description="这些工具执行前按所选档位处理；命令由规则决定"
          sectionId="settings-command-policy"
          keywords={[
            'edit',
            'write',
            'file',
            'tool',
            '编辑',
            '写入',
            '文件',
            '文件修改审批',
            '工具',
            '审批',
            '命令执行策略',
            'Agent',
          ]}
        >
          <div className="flex-1 min-w-0">
            <ToolApprovalEditor
              levels={agent.toolApprovalLevels ?? {}}
              onChange={(next) => updateAgent({ toolApprovalLevels: next })}
              onOpenCommandRules={scrollToCustomRules}
              available={approvableTools}
            />
          </div>
        </SettingItem>
        <button
          type="button"
          onClick={openPage}
          className="flex w-full items-center gap-6 px-6 py-4 text-left transition-colors hover:bg-state-soft active:bg-state-mid"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-body font-medium text-fg">内置风险规则</span>
            <span className="mt-1 block text-meta text-fg-tertiary">
              rm -rf /、pkill、curl | sh 等 {catalog?.rules.length ?? ''} 条
            </span>
          </span>
          {modifiedCount > 0 && (
            <span className="rounded-full border border-indigo-700/50 bg-indigo-500/10 px-2 py-px text-meta text-indigo-200">
              已改 {modifiedCount}
            </span>
          )}
          <ChevronRight className="h-4 w-4 flex-shrink-0 text-fg-tertiary" />
        </button>
        <SettingItem
          id="cmd-model-approval"
          label="执行前模型审批"
          description="规则之后的第二道关：规则没拦的 bash 命令，再让模型结合上下文判断放行、转人工审批或阻止"
          sectionId="settings-command-policy"
          // 引擎 / Key / 判据这些字眼只出现在展开后的子行里（开关关着时它们不挂载、不入搜索），
          // 所以在这一行补全，按界面上看到的词都能搜到。
          keywords={[
            'model',
            'approval',
            'jev',
            'typesafe',
            'api key',
            '模型',
            '审批',
            '引擎',
            '审批引擎',
            '判据',
            '审批提示词',
            '命令执行策略',
            'Agent',
          ]}
        >
          <Toggle
            checked={modelApprovalOn}
            onChange={(checked) => updateAgent({ enableModelCommandApproval: checked })}
          />
        </SettingItem>
        <Reveal show={modelApprovalOn}>
          <ModelApprovalPanel
            agent={agent}
            onChange={updateAgent}
            modelPicker={
              <Select
                value={settings.llmRegistry?.slots?.modelApprovalModelId ?? ''}
                onChange={(v) => {
                  // settings 未初始化时兜底：与 lib/llmRegistry 的
                  // emptyRegistry（空注册表唯一权威来源）同构。
                  const registry = settings.llmRegistry ?? emptyRegistry();
                  update({
                    llmRegistry: {
                      ...registry,
                      slots: { ...registry.slots, modelApprovalModelId: v },
                    },
                  });
                }}
                options={[
                  { value: '', label: '跟随会话模型' },
                  ...(settings.llmRegistry
                    ? modelOptionsByChannel(settings.llmRegistry)
                    : []),
                ]}
                placeholder="跟随会话模型"
                ariaLabel="审批模型"
                className="w-full max-w-sm"
              />
            }
          />
        </Reveal>
      </Card>
    </div>
  );
}

/**
 * 执行限制：单次任务轮数与单条命令超时。
 *
 * 从「安全与审批」里拆出来单独成段：Agent 页的顺序是 安全与审批 → 用户附加指令 → 执行限制，
 * 讲的是三件不同的事，不该挤在一张卡里。
 */
export function AgentLimitsSection() {
  const { settings, update } = useSettingsActions();
  const agent = settings.agentModeSettings;

  const updateAgent = (patch: Partial<typeof agent>) => {
    update({ agentModeSettings: { ...agent, ...patch } });
  };

  return (
    <div className="space-y-6">
      <Card
        id="settings-agent-limits"
        title="执行限制"
        description="控制 Agent 单次任务和单条命令的上限"
      >
        <SettingItem
          id="cmd-timeout"
          label="命令超时时间"
          description="Agent 执行单条命令的最长前台等待时间。到点命令不会被掐断，而是原地转为后台作业继续运行，Agent 可用 job_output 查看、job_kill 终止"
          sectionId="settings-agent-limits"
          keywords={['timeout', '超时', '命令执行策略', 'Agent']}
        >
          <div className="flex items-center gap-3 w-80">
            <input
              type="range"
              min={10}
              max={300}
              step={10}
              value={settings.commandTimeoutSecs ?? 120}
              onChange={(e) => update({ commandTimeoutSecs: Number(e.target.value) })}
              className="flex-1 accent-indigo-500"
            />
            <span className="text-body font-mono text-fg-secondary w-16 text-right">
              {settings.commandTimeoutSecs ?? 120}s
            </span>
          </div>
        </SettingItem>
        <SettingItem
          id="cmd-max-rounds"
          label="最大执行轮数"
          description="Agent 单次任务最多执行的工具调用轮数，超限自动停止"
          sectionId="settings-agent-limits"
          keywords={['max', 'rounds', '轮数', '最大', '执行轮数', 'Agent']}
        >
          <ValidatedInput
            type="number"
            value={agent.maxToolRounds ?? 500}
            onChange={(v) => updateAgent({ maxToolRounds: v })}
            validate={(s) => {
              const v = Number(s);
              if (
                !Number.isInteger(v) ||
                v < AGENT_MAX_TOOL_ROUNDS_MIN ||
                v > AGENT_MAX_TOOL_ROUNDS_MAX
              )
                return `须为 ${AGENT_MAX_TOOL_ROUNDS_MIN}-${AGENT_MAX_TOOL_ROUNDS_MAX} 的整数`;
              return null;
            }}
            validatorId="maxToolRounds"
            validatorFn={(draft) => {
              const v = draft.agentModeSettings.maxToolRounds;
              if (
                !Number.isInteger(v) ||
                v < AGENT_MAX_TOOL_ROUNDS_MIN ||
                v > AGENT_MAX_TOOL_ROUNDS_MAX
              )
                return `最大执行轮数须为 ${AGENT_MAX_TOOL_ROUNDS_MIN}-${AGENT_MAX_TOOL_ROUNDS_MAX} 的整数（当前值：${v}）`;
              return null;
            }}
            min={AGENT_MAX_TOOL_ROUNDS_MIN}
            max={AGENT_MAX_TOOL_ROUNDS_MAX}
            step={1}
            suffix="轮"
            className="w-24"
          />
        </SettingItem>
      </Card>
    </div>
  );
}
