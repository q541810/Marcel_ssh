// @vitest-environment jsdom
// 规则编辑器的交互契约：规则从后端目录读出来、改档只存差异、自定义规则能增删改、搜索能过滤。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RiskRuleCatalog } from '@/lib/types';
import type { RiskRuleOverrides } from '@/lib/riskRules';
import { resetRiskRuleCatalogCache } from '@/hooks/useRiskRuleCatalog';
import { RiskRulesEditor } from './RiskRulesEditor';

const catalog: RiskRuleCatalog = {
  rules: [
    {
      id: 'name_based_kill',
      kind: 'rule',
      scope: 'posix',
      title: '按名字批量杀进程',
      description: 'pkill 误伤面不可控',
      examples: ['pkill -f myapp'],
      defaultLevel: 'Deny',
      reason: '`{命令}` 按名字批量杀进程，误伤面不可控',
      reasonVars: [{ name: '命令', hint: '命中的命令名' }],
      lists: [
        {
          key: 'name_based_kill_commands',
          label: '按名字杀进程的命令',
          hint: '',
          defaults: ['pkill', 'killall'],
        },
      ],
    },
    {
      id: 'read_only_exempt',
      kind: 'exemption',
      scope: 'posix',
      title: '放过只读命令读受保护路径',
      description: 'cat /etc/hosts 不算写',
      examples: ['cat /etc/hosts'],
      defaultLevel: 'Allow',
      reason: '',
      reasonVars: [],
      lists: [],
    },
    {
      id: 'protected_paths',
      kind: 'rule',
      scope: 'posix',
      title: '写入受保护路径',
      description: '落在受保护路径下的写入',
      examples: [],
      defaultLevel: 'ForceApproval',
      reason: '',
      reasonVars: [],
      lists: [
        {
          key: 'protected_paths',
          label: '内置受保护目录',
          hint: '',
          defaults: ['/etc'],
        },
      ],
    },
  ],
  customRule: { reason: '命中自定义规则「{规则}」', reasonVars: [] },
};

vi.mock('@/lib/tauri', () => ({
  agentListRiskRules: vi.fn(async () => catalog),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const changes: RiskRuleOverrides[] = [];
const last = (): RiskRuleOverrides | undefined => changes[changes.length - 1];
const tried: string[] = [];

/** 受控容器：把编辑器抛出的改动落回 state，和设置页的用法一致。 */
function Harness({ initial }: { initial?: RiskRuleOverrides }) {
  const [overrides, setOverrides] = useState<RiskRuleOverrides>(initial ?? {});
  return (
    <RiskRulesEditor
      overrides={overrides}
      onChange={(next) => {
        changes.push(next);
        setOverrides(next);
      }}
      onTryExample={(cmd) => tried.push(cmd)}
    />
  );
}

async function mount(initial?: RiskRuleOverrides) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness initial={initial} />);
  });
  // 等目录的 promise 落地。
  await act(async () => {
    await Promise.resolve();
  });
}

/** 档位下拉的触发按钮（桌面用共享 `ui/Select`，无障碍名称里带着当前档位）。 */
function trigger(label: string): HTMLButtonElement {
  const el = host!.querySelector<HTMLButtonElement>(
    `button[aria-label^="${label}"]`,
  );
  if (!el) throw new Error(`找不到下拉：${label}`);
  return el;
}

/** 打开下拉，返回选项行。 */
async function openOptions(label: string): Promise<HTMLElement[]> {
  await act(async () => {
    trigger(label).click();
  });
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
}

/** 选一个选项（共享 Select 的选项走 pointerdown，不是 click）。 */
async function choose(label: string, optionText: string) {
  const options = await openOptions(label);
  const target = options.find((o) => o.textContent?.includes(optionText));
  if (!target) throw new Error(`下拉「${label}」里没有选项：${optionText}`);
  await act(async () => {
    target.dispatchEvent(
      new Event('pointerdown', { bubbles: true, cancelable: true }),
    );
  });
}

function ruleRow(id: string): HTMLElement {
  return host!.querySelector<HTMLElement>(`#risk-rule-${id}`)!;
}

function buttonByText(text: string): HTMLButtonElement {
  const el = Array.from(host!.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(text),
  );
  if (!el) throw new Error(`找不到按钮：${text}`);
  return el as HTMLButtonElement;
}

beforeEach(() => {
  // jsdom 没有 scrollIntoView（共享 Select 的键盘高亮与编辑器的定位都会调它）。
  Element.prototype.scrollIntoView = vi.fn();
  resetRiskRuleCatalogCache();
  changes.length = 0;
  tried.length = 0;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('RiskRulesEditor', () => {
  it('lists every rule from the backend catalog as one flat list', async () => {
    await mount();
    const text = host!.textContent ?? '';
    expect(text).toContain('按名字批量杀进程');
    expect(text).toContain('放过只读命令读受保护路径');
    // 不分组：没有分类标题。
    expect(text).not.toContain('破坏性操作');
    // 默认档位直接可见。
    expect(trigger('按名字批量杀进程：处置档位').textContent).toContain(
      '直接拒绝',
    );
  });

  it('changing the level stores only the difference, and marks the rule as modified', async () => {
    await mount();
    await choose('按名字批量杀进程：处置档位', '强制审批');
    expect(last()).toEqual({ name_based_kill: { level: 'ForceApproval' } });
    expect(buttonByText('已改 1')).toBeTruthy();
    expect(
      host!.querySelector('button[aria-label="按名字批量杀进程：恢复默认"]'),
    ).toBeTruthy();

    // 改回默认：覆盖项消失，"已改"标记也消失。
    await choose('按名字批量杀进程：处置档位', '直接拒绝');
    expect(last()).toEqual({});
    expect(host!.textContent).not.toContain('已改');
  });

  it('the per-row reset button restores that rule only', async () => {
    await mount();
    await choose('按名字批量杀进程：处置档位', '强制审批');
    await act(async () => {
      host!
        .querySelector<HTMLButtonElement>(
          'button[aria-label="按名字批量杀进程：恢复默认"]',
        )!
        .click();
    });
    expect(last()).toEqual({});
  });

  it('lowering a rule below its default says so, in red, once expanded', async () => {
    await mount();
    await act(async () => {
      buttonByText('按名字批量杀进程').click();
    });
    expect(host!.textContent).not.toContain('默认是「');
    await choose('按名字批量杀进程：处置档位', '放行');
    expect(host!.textContent).toContain('默认是「直接拒绝」');
  });

  it('exemptions are on/off switches that store only the off state', async () => {
    await mount();
    const toggle = host!.querySelector<HTMLButtonElement>(
      'button[role="switch"]',
    )!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      toggle.click();
    });
    expect(last()).toEqual({ read_only_exempt: { enabled: false } });
  });

  it('edits a command list and restores its default', async () => {
    await mount();
    await act(async () => {
      buttonByText('按名字批量杀进程').click();
    });
    const input = host!.querySelector<HTMLInputElement>(
      'input[aria-label="按名字杀进程的命令：添加条目"]',
    )!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, 'skill, xkill');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      buttonByText('添加').click();
    });
    expect(last()?.name_based_kill?.lists).toEqual({
      name_based_kill_commands: ['pkill', 'killall', 'skill', 'xkill'],
    });

    await act(async () => {
      buttonByText('恢复默认名单').click();
    });
    expect(last()).toEqual({});
  });

  it('the protected-paths list is edited on the main page, not here', async () => {
    await mount();
    await act(async () => {
      buttonByText('写入受保护路径').click();
    });
    expect(host!.textContent).toContain('受保护路径」里编辑');
    expect(
      host!.querySelector('input[aria-label="内置受保护目录：添加条目"]'),
    ).toBeNull();
  });

  it('clicking an example hands it to the command tester', async () => {
    await mount();
    await act(async () => {
      buttonByText('按名字批量杀进程').click();
    });
    await act(async () => {
      buttonByText('pkill -f myapp').click();
    });
    expect(tried).toEqual(['pkill -f myapp']);
  });

  it('search filters the flat list', async () => {
    await mount();
    const search = host!.querySelector<HTMLInputElement>(
      'input[aria-label="搜索命令规则"]',
    )!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(search, 'cat /etc');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const text = host!.textContent ?? '';
    expect(text).toContain('放过只读命令读受保护路径');
    expect(text).not.toContain('按名字批量杀进程');
  });

  it('the "已改 N" chip narrows the list to modified rules', async () => {
    await mount();
    await choose('按名字批量杀进程：处置档位', '请求审批');
    await act(async () => {
      buttonByText('已改 1').click();
    });
    const text = host!.textContent ?? '';
    expect(text).toContain('按名字批量杀进程');
    expect(text).not.toContain('放过只读命令读受保护路径');
  });
});

describe('refusal message on built-in rules', () => {
  const messageBox = () =>
    host!.querySelector<HTMLTextAreaElement>('textarea[aria-label$="拒绝说明"]');
  const expand = async (id: string) =>
    act(async () => {
      ruleRow(id).querySelector<HTMLButtonElement>('button[aria-expanded]')!.click();
    });

  const typeIn = async (area: HTMLTextAreaElement, text: string) =>
    act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setter.call(area, text);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });

  it('shows the default wording for a rule at 直接拒绝 and edits on top of it', async () => {
    await mount();
    await expand('name_based_kill');
    const area = messageBox()!;
    expect(area).not.toBeNull();
    expect(area.value).toBe('`{命令}` 按名字批量杀进程，误伤面不可控');
    expect(changes).toHaveLength(0);
    await typeIn(area, '`{命令}` 按名字批量杀进程，请指定进程号再杀');
    expect(last()).toEqual({
      name_based_kill: { message: '`{命令}` 按名字批量杀进程，请指定进程号再杀' },
    });
    // 改回默认原话就不算改动，覆盖项整条消失。
    await typeIn(area, '`{命令}` 按名字批量杀进程，误伤面不可控');
    expect(last()).toEqual({});
  });

  it('restores the default wording with one click', async () => {
    await mount({ name_based_kill: { message: '我的话' } });
    await expand('name_based_kill');
    expect(messageBox()!.value).toBe('我的话');
    await act(async () => {
      buttonByText('恢复默认').click();
    });
    expect(last()).toEqual({});
    expect(messageBox()!.value).toBe('`{命令}` 按名字批量杀进程，误伤面不可控');
  });

  it('has no box for a rule below 直接拒绝, nor for an exemption', async () => {
    await mount();
    await expand('protected_paths');
    expect(messageBox()).toBeNull();
    await expand('read_only_exempt');
    expect(messageBox()).toBeNull();
  });
});
