import { useState, type ReactNode } from 'react';
import { ChevronRight, Info, TriangleAlert } from 'lucide-react';
import * as tauri from '@/lib/tauri';
import type { AgentModeSettings } from '@/lib/types';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  useDefaultApprovalPrompt,
  useDefaultJevPrompt,
} from '@/hooks/useDefaultApprovalPrompt';
import Reveal from '@/components/ui/Reveal';
import SegmentedControl from '@/components/ui/SegmentedControl';
import Toggle from '@/components/ui/Toggle';
import { FULL_WIDTH_SEGMENTS } from './ApprovalOverview';
import { SettingItem } from './helpers';

export const DEFAULT_APPROVAL_PROMPT_FALLBACK =
  '（未能从后端读取内置审批提示词；留空即使用内置提示词。）';

export const DEFAULT_JEV_PROMPT_FALLBACK =
  '（未能从后端读取内置判据；留空即使用内置判据。）';

/**
 * 用户填的自定义 API 地址是否「可疑到一定会失败」：非空、但缺 `http://`/`https://`。
 *
 * 只提示、不拦截，而且**不替用户改值**：后端刻意不校验 scheme、也不因为格式可疑
 * 就静默回落官方地址（静默回落会让用户以为请求打到了自己的网关）。所以这里只
 * 提前警告一句，免得他填完才发现每条 bash 都被拦下。
 */
export function needsUrlScheme(raw: string | undefined): boolean {
  const v = (raw ?? '').trim();
  if (!v) return false;
  return !/^https?:\/\//i.test(v);
}

const OFFICIAL_HOST = 'api.typesafe.ai';

const ENGINE_OPTIONS = [
  { value: 'model', label: '跟随会话模型', title: '用本会话的模型做审批判定' },
  {
    value: 'jev',
    label: 'Jev',
    title: 'TypeSafe 的审批专用模型：更快、更便宜，需要单独配 API Key',
  },
] as const;

const ENGINE_HINT = {
  model:
    '让对话正在用的模型（或下面指定的审核模型）看一眼命令，判断放行、转人工审批还是阻止。',
  jev: 'TypeSafe 的审批专用模型，只做选择题（放行 / 转人工 / 阻止）、不写文字，所以比通用大模型更快更便宜。需要单独的 API Key。',
} as const;

/**
 * 「执行前模型审批」展开后的配置区（桌面与手机共用）。
 *
 * 版式沿用设置页的一贯做法，不另造样式：桌面是几行普通设置项（左边标签 + 短说明、右边控件，
 * 自动进设置搜索），手机是同样内容上下堆叠；引擎两端都是共用的分段控件。
 * 区块的出现、折叠区的展开、切引擎时内容的换场都走共用的 `Reveal` / `animate-fadeIn`，
 * 不是当场顶出来。
 *
 * 信息按重要性排：引擎 → 必填的一项（Jev 是 API Key，没配好就地说一次后果；会话模型是审批模型）
 * → 其余调教项。Jev 的调教项（模型 ID、API 地址、追问、判据）默认收起，只有已经改过（或地址写错了）
 * 才自动展开，免得用户以为它们是必填。原有的说明文字一句不删，只是长的挪到控件下面
 * （控件那一列比左边的标签列宽得多，不会折成五六行）。
 *
 * 「怎么选模型」这一步桌面是下拉、手机是底部弹层，由调用方经 `modelPicker` 传入。
 */
export function ModelApprovalPanel({
  agent,
  onChange,
  modelPicker,
  compact,
}: {
  agent: AgentModeSettings;
  onChange: (patch: Partial<AgentModeSettings>) => void;
  /** 「审批模型」的选择控件（桌面 Select / 手机触发弹层的按钮）。 */
  modelPicker: ReactNode;
  compact?: boolean;
}) {
  const engine = agent.commandApprovalEngine === 'jev' ? 'jev' : 'model';
  // 进页面时这块本来就在，不播任何动画；用户切过引擎之后，换场才淡入。
  const [switched, setSwitched] = useState(false);

  // key 跟引擎走：切换时整组行重新挂载并淡入，而不是文字原地一闪。
  const body = (
    <div
      key={engine}
      className={`${switched ? 'animate-fadeIn' : ''} ${
        compact ? 'space-y-4' : 'divide-y divide-edge-subtle'
      }`}
    >
      {engine === 'jev' ? (
        <JevRows agent={agent} onChange={onChange} compact={compact} />
      ) : (
        <SessionModelRows
          agent={agent}
          onChange={onChange}
          modelPicker={modelPicker}
          compact={compact}
        />
      )}
    </div>
  );

  const engineControl = (
    <div className={compact ? FULL_WIDTH_SEGMENTS : undefined}>
      <SegmentedControl
        ariaLabel="命令审批引擎"
        value={engine}
        onChange={(v) => {
          setSwitched(true);
          onChange({ commandApprovalEngine: v });
        }}
        options={ENGINE_OPTIONS}
      />
    </div>
  );

  if (compact) {
    return (
      <div className="space-y-3">
        <div className="space-y-2">
          <span className="text-meta text-fg-secondary">审批引擎</span>
          {engineControl}
          <p className="text-meta leading-relaxed text-fg-tertiary">
            {ENGINE_HINT[engine]}
          </p>
        </div>
        {body}
      </div>
    );
  }

  return (
    <div className="divide-y divide-edge-subtle border-t border-edge-subtle">
      <Row
        id="cmd-approval-engine"
        label="审批引擎"
        hint="谁来做这次判定"
        note={ENGINE_HINT[engine]}
        keywords={['引擎', 'jev', 'typesafe', '会话模型']}
      >
        {engineControl}
      </Row>
      {body}
    </div>
  );
}

/* ───────────────────────── 零件 ───────────────────────── */

/**
 * 一行设置：桌面走共用的 SettingItem（标签 + 短说明在左、控件在右，自动进设置搜索），
 * 手机上下堆叠。长一点的细节放 `note`，显示在控件下面，吃得到控件那一列的整行宽度。
 */
function Row({
  id,
  label,
  hint,
  note,
  keywords,
  compact,
  children,
}: {
  id: string;
  label: string;
  /** 标签下面的一句短说明（桌面窄标签列里放不下长句）。 */
  hint?: string;
  /** 控件下面的补充说明。 */
  note?: ReactNode;
  keywords?: string[];
  compact?: boolean;
  children: ReactNode;
}) {
  const noteEl = note ? (
    <p className="text-meta leading-relaxed text-fg-tertiary">{note}</p>
  ) : null;
  if (compact) {
    return (
      <div className="space-y-2">
        <span className="text-meta text-fg-secondary">{label}</span>
        <div className="min-w-0 space-y-2">{children}</div>
        {hint && (
          <p className="text-meta leading-relaxed text-fg-tertiary">{hint}</p>
        )}
        {noteEl}
      </div>
    );
  }
  return (
    <SettingItem
      id={id}
      label={label}
      description={hint}
      sectionId="settings-command-policy"
      keywords={['模型审批', '命令执行策略', 'Agent', ...(keywords ?? [])]}
    >
      <div className="min-w-0 space-y-2">
        {children}
        {noteEl}
      </div>
    </SettingItem>
  );
}

const INPUT =
  'w-full rounded-lg bg-field border border-edge px-3 text-fg placeholder:text-fg-tertiary focus:outline-none focus:border-indigo-500';

function inputClass(compact?: boolean) {
  return `${INPUT} font-mono ${compact ? 'py-3 text-body' : 'py-2 text-body'}`;
}

/**
 * 折叠区：收起时只占一行（标题说清里面有什么 + 右侧一句「改过什么」），点开用 `Reveal` 长出来。
 * 桌面里展开的内容仍是普通设置行，手机上是同样的一行加堆叠内容。
 */
function Collapsible({
  title,
  summary,
  warn,
  compact,
  children,
}: {
  title: string;
  summary: string;
  /** 里面有需要你处理的问题（比如地址写错了）：收起时右侧的状态改成琥珀色，不用展开也看得见。 */
  warn?: boolean;
  compact?: boolean;
  children: ReactNode;
}) {
  // 一律默认收起，点开才展开。改过什么、有没有问题由右侧的状态说，不靠自动展开。
  const [open, setOpen] = useState(false);
  return (
    <div className={compact ? 'border-t border-edge-subtle pt-1' : ''}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center gap-2 text-left transition-colors hover:bg-state-soft active:bg-state-mid ${
          compact
            ? '-mx-1 min-h-11 w-[calc(100%+0.5rem)] rounded-lg px-1'
            : 'px-6 py-3'
        }`}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 flex-shrink-0 text-fg-tertiary transition-transform duration-200 ${
            open ? 'rotate-90' : ''
          }`}
          style={{ transitionTimingFunction: 'var(--spring-smooth)' }}
        />
        <span className="text-body font-medium text-fg-secondary">{title}</span>
        {summary && (
          <span
            className={`ml-auto truncate text-meta transition-opacity duration-150 ${
              warn ? 'text-amber-400/90' : 'text-fg-tertiary'
            } ${open ? 'opacity-0' : ''}`}
          >
            {summary}
          </span>
        )}
      </button>
      <Reveal show={open}>
        <div
          className={
            compact
              ? 'space-y-4 pb-1 pt-2'
              : 'divide-y divide-edge-subtle border-t border-edge-subtle'
          }
        >
          {children}
        </div>
      </Reveal>
    </div>
  );
}

function ResetButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-meta text-fg-tertiary transition-colors hover:text-fg-secondary active:text-fg-secondary"
    >
      恢复默认
    </button>
  );
}

/** 折叠区里的布尔项：标题 + 说明 + 开关。 */
function SwitchRow({
  id,
  title,
  hint,
  note,
  checked,
  onChange,
  compact,
}: {
  id: string;
  title: string;
  hint: string;
  note?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  compact?: boolean;
}) {
  if (!compact) {
    return (
      <Row id={id} label={title} hint={hint} note={note}>
        <Toggle checked={checked} onChange={onChange} />
      </Row>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-body text-fg">{title}</span>
        <Toggle checked={checked} onChange={onChange} />
      </div>
      <p className="text-meta leading-relaxed text-fg-tertiary">
        {hint}
        {note ? `。${note}` : ''}
      </p>
    </div>
  );
}

/** 提示词：文本框 + 右下角「恢复默认」（只在改过时出现）。 */
function PromptRow({
  id,
  label,
  hint,
  note,
  value,
  customized,
  onChange,
  onReset,
  placeholder,
  compact,
}: {
  id: string;
  label: string;
  hint: string;
  note?: string;
  value: string;
  customized: boolean;
  onChange: (v: string) => void;
  onReset: () => void;
  placeholder: string;
  compact?: boolean;
}) {
  return (
    <Row id={id} label={label} hint={hint} note={note} compact={compact}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={6}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        className={`${INPUT} resize-none py-2 font-mono text-meta`}
      />
      {customized && (
        <div className="flex justify-end">
          <ResetButton onClick={onReset} />
        </div>
      )}
    </Row>
  );
}

/* ───────────────────────── Jev ───────────────────────── */

function JevRows({
  agent,
  onChange,
  compact,
}: {
  agent: AgentModeSettings;
  onChange: (patch: Partial<AgentModeSettings>) => void;
  compact?: boolean;
}) {
  // 原始 Key 只进密钥链、永不回传前端；这里只知道「有没有」。
  const hasKey = useSettingsStore((s) => s.hasJevApiKey);
  const [draft, setDraft] = useState('');

  const saveKey = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    try {
      await tauri.saveJevApiKey(trimmed);
      useSettingsStore.setState({ hasJevApiKey: true });
      setDraft('');
    } catch (err) {
      console.error('保存 TypeSafe API Key 失败:', err);
    }
  };
  const clearKey = async () => {
    try {
      await tauri.deleteJevApiKey();
      useSettingsStore.setState({ hasJevApiKey: false });
      setDraft('');
    } catch (err) {
      console.error('清除 TypeSafe API Key 失败:', err);
    }
  };

  const baseUrl = agent.jevBaseUrl?.trim() ?? '';
  const host = baseUrl ? baseUrl.replace(/\/+$/, '') : OFFICIAL_HOST;
  const defaultJevPrompt = useDefaultJevPrompt();
  const badUrl = needsUrlScheme(agent.jevBaseUrl);
  const advancedSummary = badUrl
    ? '地址缺少 http(s)://'
    : [
        agent.jevModelId?.trim() && '自定义模型',
        baseUrl && '自定义地址',
        agent.jevReasonFollowup && '追问原因',
        agent.jevApprovalPrompt?.trim() && '自定义判据',
      ]
        .filter(Boolean)
        .join(' · ');

  return (
    <>
      <Row
        id="cmd-jev-key"
        label="API Key"
        hint="只存在系统密钥链"
        keywords={['jev', 'typesafe', 'key', '密钥']}
        compact={compact}
      >
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void saveKey()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void saveKey();
              }
            }}
            placeholder={
              hasKey
                ? '已保存，输入新 Key 可覆盖'
                : '粘贴 Jev 的 API Key（官方或你的网关）'
            }
            aria-label="Jev API Key"
            autoComplete="off"
            className={`${inputClass(compact)} flex-1`}
          />
          {hasKey && (
            <button
              type="button"
              onClick={() => void clearKey()}
              className={`flex-shrink-0 rounded-lg border border-edge px-3 text-meta text-fg-secondary transition-colors hover:bg-state-soft hover:text-fg active:bg-state-mid ${
                compact ? 'py-3' : 'py-2'
              }`}
            >
              清除
            </button>
          )}
        </div>
        {/* 状态只说一次：没配就把后果讲清（不静默回退会话模型），配了就一行确认。 */}
        {hasKey ? (
          <p className="flex items-center gap-2 text-meta text-fg-tertiary">
            <span
              aria-hidden
              className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-400"
            />
            已配置
          </p>
        ) : (
          <p
            role="status"
            className="flex items-start gap-2 text-meta leading-relaxed text-amber-400/90"
          >
            <TriangleAlert className="mt-1 h-3.5 w-3.5 flex-shrink-0" />
            还没配 Key。配好之前，每条 bash
            都会被拦下并提示——不会偷偷换成会话模型来审批。
          </p>
        )}
        <p className="flex items-start gap-2 text-meta leading-relaxed text-fg-tertiary">
          <Info className="mt-1 h-3.5 w-3.5 flex-shrink-0" />
          <span>
            {baseUrl ? (
              <>
                每次审批，这条命令和最近的对话会发到你填的地址（
                <code>{host}</code>）。 如果那是第三方中转，命令里带 token
                或密码的话请留意。
              </>
            ) : (
              <>
                每次审批，这条命令和最近的对话会发到 TypeSafe（
                <code>{host}</code>），那是第三方服务器。 命令里带 token
                或密码的话请留意。
              </>
            )}
          </span>
        </p>
      </Row>

      <Collapsible
        title="模型 ID、API 地址与判据"
        summary={advancedSummary}
        warn={badUrl}
        compact={compact}
      >
        <Row
          id="cmd-jev-model"
          label="模型 ID"
          hint="留空使用内置默认"
          note={
            <>
              默认用程序内置的固定版本。不建议填 <code>jev-latest</code>
              ：它会随官方发布自动换成新版本，
              审批行为就会在你不知情时变化。通过中转或网关使用时，模型名通常是对方自己的一套
              （例如 Command Code 的 <code>typesafe/jev</code>），照对方文档填。
            </>
          }
          keywords={['jev', '模型']}
          compact={compact}
        >
          <input
            type="text"
            value={agent.jevModelId ?? ''}
            onChange={(e) => onChange({ jevModelId: e.target.value })}
            placeholder="留空使用内置默认（钉版本号）"
            aria-label="Jev 模型 ID"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={inputClass(compact)}
          />
        </Row>

        <Row
          id="cmd-jev-url"
          label="API 地址"
          hint="留空使用官方地址"
          note={
            <>
              只有走代理、私有网关或本地调试服务时才需要填。程序会自动在后面拼上{' '}
              <code>/v1/systemone</code>，所以对方文档给的地址如果以{' '}
              <code>/v1</code> 结尾（例如{' '}
              <code>https://api.commandcode.ai/provider/v1</code>
              ），请去掉这一段，否则会变成 <code>…/v1/v1/systemone</code>，请求
              404 失败。
            </>
          }
          keywords={['jev', '地址', 'url', '网关', '代理']}
          compact={compact}
        >
          <input
            type="text"
            value={agent.jevBaseUrl ?? ''}
            onChange={(e) => onChange({ jevBaseUrl: e.target.value })}
            placeholder={`留空使用官方地址 ${OFFICIAL_HOST}`}
            aria-label="Jev API 地址"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={inputClass(compact)}
          />
          {needsUrlScheme(agent.jevBaseUrl) && (
            <p className="flex items-start gap-2 text-meta leading-relaxed text-amber-400/90">
              <TriangleAlert className="mt-1 h-3.5 w-3.5 flex-shrink-0" />
              <span>
                地址缺少 <code>http://</code> 或 <code>https://</code>
                ，请求会失败，每条 bash 都会被拦下。请补上开头。
              </span>
            </p>
          )}
        </Row>

        <SwitchRow
          id="cmd-jev-followup"
          title="追问原因"
          hint="被转人工或阻止时，多问一轮「为什么」"
          note="Jev 不会写理由，只能从几个固定标签里挑（如「会删除或覆盖数据」「会接触凭据或密钥」）。有时一个标签都没命中，你就会看到「需要确认」却没有任何解释。打开后，这类命令会多发一次请求专门补理由：延迟和花费各多一份；补理由失败也不影响判定结果。"
          checked={agent.jevReasonFollowup ?? false}
          onChange={(v) => onChange({ jevReasonFollowup: v })}
          compact={compact}
        />

        <PromptRow
          id="cmd-jev-prompt"
          label="Jev 判据"
          hint="在内置判据上修改"
          note="告诉 Jev 看什么、怎么区分放行 / 转人工 / 阻止。只写要判断什么，不要写输出格式——Jev 只会从选项里选，不会写文字，格式要求只会变成干扰。"
          value={
            agent.jevApprovalPrompt?.trim()
              ? agent.jevApprovalPrompt
              : defaultJevPrompt
          }
          customized={!!agent.jevApprovalPrompt?.trim()}
          // 与内置文本完全一致就存回空串，即「未自定义」（与审批提示词同一套）。
          onChange={(v) =>
            onChange({ jevApprovalPrompt: v === defaultJevPrompt ? '' : v })
          }
          onReset={() => onChange({ jevApprovalPrompt: '' })}
          placeholder={DEFAULT_JEV_PROMPT_FALLBACK}
          compact={compact}
        />
      </Collapsible>
    </>
  );
}

/* ───────────────────────── 会话模型 ───────────────────────── */

function SessionModelRows({
  agent,
  onChange,
  modelPicker,
  compact,
}: {
  agent: AgentModeSettings;
  onChange: (patch: Partial<AgentModeSettings>) => void;
  modelPicker: ReactNode;
  compact?: boolean;
}) {
  const defaultPrompt = useDefaultApprovalPrompt();

  return (
    <>
      <Row
        id="cmd-approval-model"
        label="审批模型"
        hint="留空跟随会话模型"
        note="选择更小更快的模型可降低审批延迟和成本。留空 = 跟随本会话正在使用的模型。"
        keywords={['模型']}
        compact={compact}
      >
        {modelPicker}
      </Row>

      <Collapsible
        title="审批提示词"
        summary={agent.modelApprovalPrompt ? '已自定义' : '内置默认'}
        compact={compact}
      >
        <PromptRow
          id="cmd-approval-prompt"
          label="审批提示词"
          hint="在内置提示词上修改"
          value={agent.modelApprovalPrompt || defaultPrompt}
          customized={!!agent.modelApprovalPrompt}
          // 与内置文本完全一致就存回空串，即「未自定义」。
          onChange={(v) =>
            onChange({ modelApprovalPrompt: v === defaultPrompt ? '' : v })
          }
          onReset={() => onChange({ modelApprovalPrompt: '' })}
          placeholder={DEFAULT_APPROVAL_PROMPT_FALLBACK}
          compact={compact}
        />
      </Collapsible>
    </>
  );
}
