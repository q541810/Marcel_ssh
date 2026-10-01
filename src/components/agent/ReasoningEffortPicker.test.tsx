// @vitest-environment jsdom
import { act, useState, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReasoningEffortPicker } from './ReasoningEffortPicker';

type PickerProps = ComponentProps<typeof ReasoningEffortPicker>;
type HarnessProps = Omit<PickerProps, 'value'> & { initialValue?: string | null };

let host: HTMLDivElement;
let root: Root;

function ControlledPicker({ initialValue = 'low', onChange, ...props }: HarnessProps) {
  const [value, setValue] = useState<string | null>(initialValue);
  return (
    <ReasoningEffortPicker
      {...props}
      value={value}
      onChange={async (effort) => {
        await onChange(effort);
        setValue(effort);
      }}
    />
  );
}

async function renderPicker(props: Partial<HarnessProps> = {}) {
  const onChange = props.onChange ?? vi.fn<(effort: string | null) => Promise<void>>().mockResolvedValue(undefined);
  await act(async () => {
    root.render(<ControlledPicker efforts={['low', 'medium', 'high']} {...props} onChange={onChange} />);
  });
  return onChange;
}

function trigger(): HTMLButtonElement {
  const button = host.querySelector('button');
  if (!button) throw new Error('Missing reasoning effort trigger');
  return button;
}

function slider(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="range"]');
  if (!input) throw new Error('Missing reasoning effort slider');
  return input;
}

function dialog(): HTMLDivElement {
  const element = document.querySelector<HTMLDivElement>('[role="dialog"]');
  if (!element) throw new Error('Missing reasoning effort dialog');
  return element;
}

function anchorRect(top: number, left = 30): DOMRect {
  return new DOMRect(left, top, 90, 32);
}

function mockAnchor(rect: DOMRect) {
  const container = trigger().parentElement;
  if (!container) throw new Error('Missing reasoning effort anchor');
  return vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(rect);
}

function resetButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('[aria-label="恢复默认思考强度"]');
  if (!button) throw new Error('Missing reset button');
  return button;
}

async function click(button: HTMLButtonElement) {
  await act(async () => button.click());
}

async function pointer(type: 'pointerdown' | 'pointerup' | 'pointercancel') {
  await act(async () => {
    slider().dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1 }));
  });
}

async function key(type: 'keydown' | 'keyup', keyName: string) {
  await act(async () => {
    slider().dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: keyName }));
  });
}

// jsdom does not perform a range input's native pointer/keyboard value changes.
// Use the native setter so React receives the same input event as a browser.
async function changeRange(value: number) {
  await act(async () => {
    const input = slider();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Missing native input value setter');
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function dragTo(value: number) {
  await pointer('pointerdown');
  await changeRange(value);
  await pointer('pointerup');
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ReasoningEffortPicker', () => {
  it('previews a drag and saves only the final declared effort on release', async () => {
    const onChange = await renderPicker();
    await click(trigger());
    expect(document.activeElement).toBe(slider());

    await pointer('pointerdown');
    await changeRange(2);
    await changeRange(3);
    expect(slider().getAttribute('aria-valuetext')).toBe('高');
    expect(onChange).not.toHaveBeenCalled();

    await pointer('pointerup');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('high');
    expect(slider().value).toBe('3');
    expect(trigger().getAttribute('aria-label')).toBe('思考强度：高');
  });

  it('restores the default with null and preserves custom provider effort values', async () => {
    const onChange = await renderPicker({ efforts: ['high', 'vendor-deep', 'low'], initialValue: 'high' });
    await click(trigger());
    await click(resetButton());
    expect(onChange).toHaveBeenNthCalledWith(1, null);
    expect(slider().value).toBe('0');

    await pointer('pointerdown');
    await changeRange(2);
    await pointer('pointerup');
    expect(onChange).toHaveBeenNthCalledWith(2, 'vendor-deep');
    expect(slider().getAttribute('aria-valuetext')).toBe('vendor-deep');
    await dragTo(3);
    expect(onChange).toHaveBeenNthCalledWith(3, 'low');
  });

  it('shows default for an obsolete effort without automatically saving a replacement', async () => {
    const onChange = await renderPicker({ initialValue: 'removed-effort' });
    await click(trigger());
    expect(slider().value).toBe('0');
    expect(slider().getAttribute('aria-valuetext')).toBe('默认');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commits a held keyboard adjustment once on keyup and supports Home', async () => {
    const onChange = await renderPicker();
    await click(trigger());
    await key('keydown', 'ArrowRight');
    await changeRange(2);
    await key('keydown', 'ArrowRight');
    await changeRange(3);
    expect(onChange).not.toHaveBeenCalled();

    await key('keyup', 'ArrowRight');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('high');
    await key('keydown', 'Home');
    await changeRange(0);
    await key('keyup', 'Home');
    expect(onChange).toHaveBeenNthCalledWith(2, null);
  });

  it('discards a cancelled drag and allows a subsequent change', async () => {
    const onChange = await renderPicker();
    await click(trigger());
    await pointer('pointerdown');
    await changeRange(3);
    await pointer('pointercancel');
    await pointer('pointerup');
    expect(onChange).not.toHaveBeenCalled();
    expect(slider().value).toBe('1');
    expect(slider().getAttribute('aria-valuetext')).toBe('低');

    await dragTo(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('medium');
  });

  it('Escape discards the draft, closes the dialog, and restores trigger focus', async () => {
    const onChange = await renderPicker();
    await click(trigger());
    await key('keydown', 'End');
    await changeRange(3);
    await key('keydown', 'Escape');
    await pointer('pointerup');
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());

    await click(trigger());
    expect(slider().value).toBe('1');
    expect(slider().getAttribute('aria-valuetext')).toBe('低');
  });

  it('locks controls while saving and rolls back failed saves with a retryable error', async () => {
    let rejectSave: (reason: Error) => void = () => { throw new Error('Save was not started'); };
    const onChange = vi.fn<(effort: string | null) => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSave = reject; }))
      .mockResolvedValue(undefined);
    await renderPicker({ onChange });
    await click(trigger());
    await dragTo(3);
    expect(slider().disabled).toBe(true);
    expect(resetButton().disabled).toBe(true);
    expect(slider().getAttribute('aria-valuetext')).toBe('高');
    await click(resetButton());
    expect(onChange).toHaveBeenCalledTimes(1);

    await act(async () => rejectSave(new Error('Could not persist effort')));
    expect(slider().disabled).toBe(false);
    expect(slider().value).toBe('1');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('未能保存');

    await dragTo(3);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(slider().value).toBe('3');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('prevents opening while disabled and disables an already open dialog', async () => {
    const onChange = await renderPicker({ disabled: true });
    await click(trigger());
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await renderPicker({ onChange, disabled: false });
    await click(trigger());
    await renderPicker({ onChange, disabled: true });
    expect(trigger().disabled).toBe(true);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(slider().disabled).toBe(true);
    await click(resetButton());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('discards an uncommitted drag when the picker becomes disabled', async () => {
    const onChange = await renderPicker();
    await click(trigger());
    await pointer('pointerdown');
    await changeRange(3);

    await renderPicker({ onChange, disabled: true });
    await renderPicker({ onChange, disabled: false });
    if (trigger().getAttribute('aria-expanded') === 'false') await click(trigger());
    expect(slider().value).toBe('1');
    expect(slider().getAttribute('aria-valuetext')).toBe('低');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('opens below a trigger near the top and above a trigger near the bottom', async () => {
    vi.stubGlobal('innerHeight', 700);
    await renderPicker();
    const anchor = mockAnchor(anchorRect(4));
    await click(trigger());
    expect(dialog().style.top).toBe('44px');
    expect(dialog().style.bottom).toBe('');
    expect(Number.parseFloat(dialog().style.maxHeight)).toBeGreaterThan(240);

    anchor.mockReturnValue(anchorRect(650));
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(dialog().style.top).toBe('');
    expect(dialog().style.bottom).toBe('58px');
    expect(Number.parseFloat(dialog().style.maxHeight)).toBeGreaterThan(240);
  });

  it('keeps the dialog within the visible viewport when the keyboard resizes or pans it', async () => {
    vi.stubGlobal('innerHeight', 800);
    const viewport = Object.assign(new EventTarget(), { width: 380, height: 700, offsetTop: 0, offsetLeft: 0 });
    vi.stubGlobal('visualViewport', viewport);
    await renderPicker();
    const anchor = mockAnchor(anchorRect(600, 320));
    await click(trigger());

    Object.assign(viewport, { width: 280, height: 300, offsetTop: 50, offsetLeft: 20 });
    await act(async () => viewport.dispatchEvent(new Event('resize')));
    expect(dialog().style.left).toBe('64px');
    expect(dialog().style.width).toBe('228px');
    expect(dialog().style.bottom).toBe('458px');
    expect(dialog().style.maxHeight).toBe('284px');

    viewport.offsetTop = 120;
    anchor.mockReturnValue(anchorRect(125, 320));
    await act(async () => viewport.dispatchEvent(new Event('scroll')));
    expect(dialog().style.bottom).toBe('');
    expect(dialog().style.top).toBe('165px');
    expect(dialog().style.maxHeight).toBe('247px');
    expect(Number.parseFloat(dialog().style.top) + Number.parseFloat(dialog().style.maxHeight))
      .toBeLessThanOrEqual(viewport.offsetTop + viewport.height - 8);
  });

  it('shows the model with extreme and Ultra styles and resets to default', async () => {
    const onChange = await renderPicker({
      efforts: ['low', 'xhigh', 'ultra'],
      initialValue: 'xhigh',
      modelName: '6 Astra',
    });
    await click(trigger());
    expect(dialog().querySelector('h3')?.textContent).toBe('极高');
    expect(dialog().textContent).toContain('6 Astra');
    expect(dialog().classList.contains('reasoning-effort-ultra')).toBe(false);
    expect(dialog().querySelectorAll('button')).toHaveLength(2);

    await dragTo(3);
    expect(slider().getAttribute('aria-valuetext')).toBe('Ultra');
    expect(dialog().classList.contains('reasoning-effort-ultra')).toBe(true);
    expect(dialog().querySelector('.reasoning-effort-stars')).not.toBeNull();
    await click(resetButton());
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(resetButton().disabled).toBe(true);
    expect(slider().getAttribute('aria-valuetext')).toBe('默认');
  });

  it('keeps the full-power animation when max is the final level', async () => {
    await renderPicker({ efforts: ['low', 'max'], initialValue: 'low' });
    await click(trigger());

    await dragTo(2);
    expect(slider().getAttribute('aria-valuetext')).toBe('最高');
    expect(dialog().classList.contains('reasoning-effort-ultra')).toBe(true);
    expect(dialog().querySelector('.reasoning-effort-stars')).not.toBeNull();
  });

  it('keeps the model-settings entry visible and opens model choices when efforts are unavailable', async () => {
    const onChange = await renderPicker({ efforts: [], modelName: '6 Astra' });
    // The registry is optional in the standalone picker; the parent passes it
    // to enable the combined model-settings entry point.
    await renderPicker({
      efforts: [],
      modelName: '6 Astra',
      registry: {
        channels: [{ id: 'local', name: '本地', baseUrl: '', enabled: true }],
        models: [{
          id: 'astra', channelId: 'local', modelName: '6 Astra', temperature: 0,
          reasoningEfforts: [],
        }],
        slots: { modelApprovalModelId: '', summarizerModelId: '' },
        netPolicy: {
          maxRetries: 1, retryDelaySecs: 5, retryHttpStatuses: '408',
          firstByteTimeoutSecs: 60, retryOnTimeout: true,
        },
      },
      modelId: 'astra',
      onModelChange: vi.fn(),
    });
    await click(trigger());
    expect(document.querySelector('input[type="range"]')).toBeNull();
    expect(dialog().textContent).not.toContain('选择模型');
    expect(dialog().querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe('选择模型');
    expect(dialog().textContent).toContain('6 Astra');
    expect(onChange).not.toHaveBeenCalled();
  });
});
