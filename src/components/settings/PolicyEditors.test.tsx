// @vitest-environment jsdom
// 命令执行策略主页面的三个编辑器：受保护路径（内置 + 自己加的一份名单）、需要审批的工具、自定义规则。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CustomRiskRule, RiskRuleInfo } from '@/lib/types';
import type { RiskRuleOverrides } from '@/lib/riskRules';
import type { ToolApprovalLevels } from '@/lib/toolApproval';
import { flashCustomRule } from '@/lib/riskRuleNav';
import { CustomRiskRulesEditor } from './CustomRiskRulesEditor';
import {
  ProtectedPathsEditor,
  type ProtectedPathsPatch,
} from './ProtectedPathsEditor';
import { ToolApprovalEditor } from './ToolApprovalEditor';

const validate = vi.fn(
  async (_paths: string[]): Promise<string | null> => null,
);
vi.mock('@/lib/tauri', () => ({
  validateCustomProtectedPaths: (paths: string[]) => validate(paths),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  validate.mockClear();
});

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

function buttonByText(text: string): HTMLButtonElement {
  const el = Array.from(host!.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(text),
  );
  if (!el) throw new Error(`找不到按钮：${text}`);
  return el as HTMLButtonElement;
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ToolApprovalEditor', () => {
  function Harness({ initial }: { initial: ToolApprovalLevels }) {
    const [levels, setLevels] = useState(initial);
    return (
      <>
        <ToolApprovalEditor levels={levels} onChange={setLevels} />
        <output data-testid="levels">{JSON.stringify(levels)}</output>
      </>
    );
  }
  const read = () => JSON.parse(host!.querySelector('output')!.textContent!);

  it('always shows bash first as a read-only chip pointing at the command rules', async () => {
    const open = vi.fn();
    await render(
      <ToolApprovalEditor
        levels={{ edit_file: 'Approval' }}
        onChange={() => {}}
        onOpenCommandRules={open}
      />,
    );
    const text = host!.textContent!;
    expect(text.indexOf('执行命令')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('执行命令')).toBeLessThan(text.indexOf('编辑文件'));
    // 只读：点它是去看命令规则，不会展开档位下拉，也没有移除按钮。
    await act(async () => {
      buttonByText('执行命令').click();
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(host!.querySelector('[aria-label^="执行命令：审批档位"]')).toBeNull();
    expect(host!.querySelector('[aria-label="执行命令不再审批"]')).toBeNull();
  });

  it('shows the named tools with their level, and nothing else', async () => {
    await render(
      <Harness
        initial={{ edit_file: 'Approval', write_file: 'ForceApproval' }}
      />,
    );
    const text = host!.textContent!;
    expect(text).toContain('编辑文件');
    expect(text).toContain('写入文件');
    expect(text).not.toContain('读取文件');
  });

  it('removing a tool stops approving it; adding it back starts at 请求审批', async () => {
    await render(
      <Harness initial={{ edit_file: 'Deny', write_file: 'Approval' }} />,
    );
    // 点工具标签才展开它的编辑区，里面有「不再审批」。
    expect(host!.querySelector('[aria-label="编辑文件不再审批"]')).toBeNull();
    await act(async () => {
      buttonByText('编辑文件').click();
    });
    await act(async () => {
      host!
        .querySelector<HTMLButtonElement>(
          'button[aria-label="编辑文件不再审批"]',
        )!
        .click();
    });
    expect(read()).toEqual({ write_file: 'Approval' });
    // 移掉之后编辑区跟着收起。
    expect(host!.querySelector('[aria-label="编辑文件不再审批"]')).toBeNull();

    await act(async () => {
      buttonByText('添加工具').click();
    });
    await act(async () => {
      buttonByText('+ 编辑文件').click();
    });
    expect(read()).toEqual({ write_file: 'Approval', edit_file: 'Approval' });
    // 加完直接展开它，默认档位不合意当场能改。
    expect(
      host!.querySelector('button[aria-label^="编辑文件：审批档位"]'),
    ).not.toBeNull();
  });

  it('the level dropdown has no 放行 option', async () => {
    await render(<Harness initial={{ edit_file: 'Approval' }} />);
    await act(async () => {
      buttonByText('编辑文件').click();
    });
    await act(async () => {
      host!
        .querySelector<HTMLButtonElement>(
          'button[aria-label^="编辑文件：审批档位"]',
        )!
        .click();
    });
    const options = Array.from(document.querySelectorAll('[role="option"]')).map(
      (o) => o.textContent,
    );
    expect(options).toHaveLength(3);
    expect(options.join('')).not.toContain('放行');
  });

  it('is one row of chips: no editor and no picker until you ask for one', async () => {
    await render(
      <Harness initial={{ edit_file: 'Approval', write_file: 'Deny' }} />,
    );
    expect(host!.querySelector('[aria-label$="：审批档位"]')).toBeNull();
    expect(host!.textContent).not.toContain('读取文件');
    expect(host!.textContent).not.toContain('不再审批');
  });

  it('opens one panel at a time: a tool editor or the add list, never both', async () => {
    await render(
      <Harness initial={{ edit_file: 'Approval', write_file: 'Deny' }} />,
    );
    await act(async () => {
      buttonByText('编辑文件').click();
    });
    expect(host!.querySelector('[aria-label^="编辑文件：审批档位"]')).not.toBeNull();
    // 点另一个工具：换成它的编辑区。
    await act(async () => {
      buttonByText('写入文件').click();
    });
    expect(host!.querySelector('[aria-label^="编辑文件：审批档位"]')).toBeNull();
    expect(host!.querySelector('[aria-label^="写入文件：审批档位"]')).not.toBeNull();
    // 点「添加工具」：编辑区收起，换成可添加的清单。
    await act(async () => {
      buttonByText('添加工具').click();
    });
    expect(host!.querySelector('[aria-label^="写入文件：审批档位"]')).toBeNull();
    expect(host!.textContent).toContain('+ 读取文件');
    // 再点一下清单收起；再点已展开的工具标签也是收起。
    await act(async () => {
      buttonByText('添加工具').click();
    });
    expect(host!.textContent).not.toContain('+ 读取文件');
    await act(async () => {
      buttonByText('编辑文件').click();
    });
    await act(async () => {
      buttonByText('编辑文件').click();
    });
    expect(host!.querySelector('[aria-label^="编辑文件：审批档位"]')).toBeNull();
  });

  it('offers every tool the backend reports, grouped, and lets you add the ones the old list missed', async () => {
    const onChange = vi.fn();
    await render(
      <ToolApprovalEditor
        levels={{}}
        onChange={onChange}
        available={['read_file', 'subagent', 'system_info', 'brand_new_tool']}
      />,
    );
    await act(async () => {
      buttonByText('添加工具').click();
    });
    const text = host!.textContent!;
    // 分组名与前端从没登记过的工具都在（以前的清单里没有 subagent / system_info）。
    for (const s of ['文件', '服务器', 'Agent', '其他']) expect(text).toContain(s);
    expect(text).toContain('+ 派发子 agent');
    expect(text).toContain('+ 系统信息');
    expect(text).toContain('+ brand_new_tool');
    // 后端没报的，即使前端认识也不给。
    expect(text).not.toContain('+ 写入文件');
    await act(async () => {
      buttonByText('+ 派发子 agent').click();
    });
    expect(onChange).toHaveBeenCalledWith({ subagent: 'Approval' });
  });

  it('says so when the tool shares its entry with the local counterpart', async () => {
    await render(<Harness initial={{ edit_file: 'Approval', ask_user: 'Approval' }} />);
    await act(async () => {
      buttonByText('编辑文件').click();
    });
    expect(host!.textContent).toContain('本机子 agent 里的同名工具共用这一条');
    await act(async () => {
      buttonByText('向你提问').click();
    });
    expect(host!.textContent).not.toContain('本机子 agent 里的同名工具共用这一条');
  });
});

describe('ProtectedPathsEditor', () => {
  const rule: RiskRuleInfo = {
    id: 'protected_paths',
    kind: 'rule',
    scope: 'posix',
    title: '写入受保护路径',
    description: '',
    examples: [],
    defaultLevel: 'ForceApproval',
    reason: '',
    reasonVars: [],
    lists: [
      {
        key: 'protected_paths',
        label: '目录',
        hint: '',
        defaults: ['/etc', '/boot', '/sys'],
      },
    ],
  };

  function Harness({ initial }: { initial?: RiskRuleOverrides }) {
    const [overrides, setOverrides] = useState<RiskRuleOverrides>(
      initial ?? {},
    );
    const [custom, setCustom] = useState<string[]>([]);
    return (
      <>
        <ProtectedPathsEditor
          rule={rule}
          overrides={overrides}
          customPaths={custom}
          onChange={(patch: ProtectedPathsPatch) => {
            if (patch.riskRuleOverrides) setOverrides(patch.riskRuleOverrides);
            if (patch.customProtectedPaths)
              setCustom(patch.customProtectedPaths);
          }}
        />
        <output>{JSON.stringify({ overrides, custom })}</output>
      </>
    );
  }
  const read = () => JSON.parse(host!.querySelector('output')!.textContent!);

  it('built-in directories are listed (tagged 内置) and can be removed and restored', async () => {
    await render(<Harness />);
    expect(host!.textContent).toContain('/etc');
    expect(host!.textContent).toContain('内置');

    await act(async () => {
      host!
        .querySelector<HTMLButtonElement>('button[aria-label="移除 /boot"]')!
        .click();
    });
    expect(read().overrides).toEqual({
      protected_paths: { lists: { protected_paths: ['/etc', '/sys'] } },
    });
    // 删掉的留一个划线占位，点 ↺ 找回，名单回到默认 → 覆盖项消失。
    await act(async () => {
      host!
        .querySelector<HTMLButtonElement>('button[aria-label="找回 /boot"]')!
        .click();
    });
    expect(read().overrides).toEqual({});
  });

  it("a new directory goes to the user's own list, after the backend validates it", async () => {
    await render(<Harness />);
    const input = host!.querySelector<HTMLInputElement>(
      'input[aria-label="添加受保护路径"]',
    )!;
    await typeInto(input, '/home/me/.ssh');
    await act(async () => {
      buttonByText('添加').click();
    });
    expect(validate).toHaveBeenCalledWith(['/home/me/.ssh']);
    expect(read().custom).toEqual(['/home/me/.ssh']);
  });

  it('a path the backend rejects is not added, and the reason is shown', async () => {
    validate.mockResolvedValueOnce('必须是绝对路径');
    await render(<Harness />);
    const input = host!.querySelector<HTMLInputElement>(
      'input[aria-label="添加受保护路径"]',
    )!;
    await typeInto(input, 'relative/dir');
    await act(async () => {
      buttonByText('添加').click();
    });
    expect(read().custom).toEqual([]);
    expect(host!.textContent).toContain('必须是绝对路径');
  });

  it('typing a removed built-in directory restores it instead of adding a duplicate', async () => {
    await render(
      <Harness
        initial={{
          protected_paths: { lists: { protected_paths: ['/etc', '/sys'] } },
        }}
      />,
    );
    const input = host!.querySelector<HTMLInputElement>(
      'input[aria-label="添加受保护路径"]',
    )!;
    await typeInto(input, '/boot');
    await act(async () => {
      buttonByText('添加').click();
    });
    expect(read().overrides).toEqual({});
    expect(read().custom).toEqual([]);
  });
});

describe('CustomRiskRulesEditor', () => {
  function Harness() {
    const [rules, setRules] = useState<CustomRiskRule[]>([]);
    return (
      <>
        <CustomRiskRulesEditor rules={rules} onChange={setRules} />
        <output>{JSON.stringify(rules)}</output>
      </>
    );
  }
  const read = () => JSON.parse(host!.querySelector('output')!.textContent!);

  it('adds a row (conservative default), edits it, and deletes it', async () => {
    await render(<Harness />);
    await act(async () => {
      buttonByText('添加规则').click();
    });
    expect(read()).toHaveLength(1);
    expect(read()[0]).toMatchObject({
      command: '',
      level: 'ForceApproval',
      enabled: true,
    });

    await typeInto(
      host!.querySelector<HTMLInputElement>(
        'input[aria-label="自定义规则：命令名"]',
      )!,
      'docker',
    );
    await typeInto(
      host!.querySelector<HTMLInputElement>(
        'input[aria-label="自定义规则：参数包含"]',
      )!,
      'prune',
    );
    expect(read()[0]).toMatchObject({
      command: 'docker',
      argContains: 'prune',
    });

    await act(async () => {
      host!
        .querySelector<HTMLButtonElement>('button[aria-label="删除这条规则"]')!
        .click();
    });
    expect(read()).toEqual([]);
  });

  it('shows an example when there are no rules yet', async () => {
    await render(<Harness />);
    expect(host!.textContent).toContain('还没有规则');
    expect(host!.textContent).toContain('docker');
  });

  describe('refusal message', () => {
    const reasonTemplate = {
      reason: '命中自定义规则「{规则}」',
      reasonVars: [{ name: '规则', hint: '这条规则的名字' }],
    };
    function WithRule({ level }: { level: CustomRiskRule['level'] }) {
      const [rules, setRules] = useState<CustomRiskRule[]>([
        {
          id: 'r1',
          name: '',
          command: 'docker',
          argContains: 'prune',
          level,
          enabled: true,
          message: '',
        },
      ]);
      return (
        <>
          <CustomRiskRulesEditor
            rules={rules}
            onChange={setRules}
            reasonTemplate={reasonTemplate}
          />
          <output>{JSON.stringify(rules)}</output>
        </>
      );
    }
    const openRule = async () =>
      act(async () => {
        host!.querySelector<HTMLButtonElement>('#risk-rule-r1')!.click();
      });
    const box = () =>
      host!.querySelector<HTMLTextAreaElement>('textarea[aria-label$="拒绝说明"]');

    it('has no message box at a level that asks instead of refusing', async () => {
      await render(<WithRule level="ForceApproval" />);
      await openRule();
      expect(box()).toBeNull();
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

    it('starts from the default wording the Agent would get, not an empty box', async () => {
      await render(<WithRule level="Deny" />);
      await openRule();
      expect(box()!.value).toBe('命中自定义规则「{规则}」');
      // 没动过 = 什么都不存，仍走默认。
      expect(read()[0].message).toBe('');
      // 能用的占位列在框下面。
      expect(host!.textContent).toContain('{规则}');
    });

    it('edits on top of the default, stores only a real change, and can go back', async () => {
      await render(<WithRule level="Deny" />);
      await openRule();
      await typeIn(box()!, '命中自定义规则「{规则}」，生产库禁止清理');
      expect(read()[0].message).toBe('命中自定义规则「{规则}」，生产库禁止清理');
      await act(async () => {
        buttonByText('恢复默认').click();
      });
      expect(read()[0].message).toBe('');
      expect(box()!.value).toBe('命中自定义规则「{规则}」');
      // 改回和默认一字不差，也不算改动。
      await typeIn(box()!, '别的话');
      await typeIn(box()!, '命中自定义规则「{规则}」');
      expect(read()[0].message).toBe('');
    });

    it('a placeholder button inserts at the cursor', async () => {
      await render(<WithRule level="Deny" />);
      await openRule();
      const area = box()!;
      await typeIn(area, '禁止：');
      area.setSelectionRange(3, 3);
      await act(async () => {
        buttonByText('{规则}').click();
      });
      expect(read()[0].message).toBe('禁止：{规则}');
    });
  });

  it('warns that a command with spaces will not take effect', async () => {
    await render(<Harness />);
    await act(async () => {
      buttonByText('添加规则').click();
    });
    await typeInto(
      host!.querySelector<HTMLInputElement>(
        'input[aria-label="自定义规则：命令名"]',
      )!,
      'docker system',
    );
    expect(host!.textContent).toContain('这条规则不生效');
  });
});

describe('CustomRiskRulesEditor chips', () => {
  const rule = (id: string, command: string, extra: Partial<CustomRiskRule> = {}) =>
    ({
      id,
      name: '',
      command,
      argContains: '',
      level: 'Approval',
      enabled: true,
      ...extra,
    }) as CustomRiskRule;

  function Harness({ initial }: { initial: CustomRiskRule[] }) {
    const [rules, setRules] = useState(initial);
    return (
      <>
        <CustomRiskRulesEditor rules={rules} onChange={setRules} />
        <output>{JSON.stringify(rules)}</output>
      </>
    );
  }
  const five = ['rm', 'mkfs', 'dd', 'shutdown', 'reboot'].map((c) => rule(`d-${c}`, c));
  const chip = (id: string) =>
    host!.querySelector<HTMLButtonElement>(`#risk-rule-${id}`)!;
  const cmdInput = () =>
    host!.querySelector<HTMLInputElement>('input[aria-label="自定义规则：命令名"]');

  it('shows every rule as one chip and no inputs until one is opened', async () => {
    await render(<Harness initial={five} />);
    for (const c of ['rm', 'mkfs', 'dd', 'shutdown', 'reboot']) {
      expect(chip(`d-${c}`).textContent).toBe(c);
    }
    expect(host!.querySelector('input')).toBeNull();
  });

  it('opens one rule at a time and closes it when the same chip is clicked again', async () => {
    await render(<Harness initial={five} />);
    await act(async () => {
      chip('d-mkfs').click();
    });
    expect(cmdInput()!.value).toBe('mkfs');
    await act(async () => {
      chip('d-dd').click();
    });
    expect(host!.querySelectorAll('input[aria-label="自定义规则：命令名"]')).toHaveLength(1);
    expect(cmdInput()!.value).toBe('dd');
    await act(async () => {
      chip('d-dd').click();
    });
    expect(cmdInput()).toBeNull();
  });

  it('marks a disabled rule on its chip', async () => {
    await render(<Harness initial={[rule('a', 'rm'), rule('b', 'dd', { enabled: false })]} />);
    expect(chip('b').title).toContain('已关闭');
    expect(chip('a').title).toContain('请求审批');
  });

  it('a reveal request opens the named rule', async () => {
    await render(<Harness initial={five} />);
    await act(async () => {
      flashCustomRule('d-shutdown');
    });
    expect(cmdInput()!.value).toBe('shutdown');
  });
});
