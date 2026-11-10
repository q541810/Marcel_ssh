// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { installNativeContextMenuGuard, shouldKeepNativeContextMenu } from './nativeContextMenu';

afterEach(() => {
  document.body.innerHTML = '';
  document.getSelection()?.removeAllRanges();
});

function rightClick(target: Element): MouseEvent {
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
}

describe('屏蔽浏览器自带右键菜单', () => {
  it('空白处 / 普通元素：拦掉原生菜单', () => {
    document.body.innerHTML = '<div id="blank">hi</div>';
    const off = installNativeContextMenuGuard();
    expect(rightClick(document.getElementById('blank')!).defaultPrevented).toBe(true);
    off();
  });

  it('输入框、文本域、可编辑区：保留原生菜单（粘贴等）', () => {
    document.body.innerHTML = '<input id="i"><textarea id="t"></textarea><div id="c" contenteditable="true"><b id="in">x</b></div>';
    const off = installNativeContextMenuGuard();
    for (const id of ['i', 't', 'c', 'in']) {
      expect(rightClick(document.getElementById(id)!).defaultPrevented).toBe(false);
    }
    off();
  });

  it('右键点在选中的文字上保留（复制），点在别处仍拦', () => {
    document.body.innerHTML = '<p id="a">选中的文字</p><p id="b">别处</p>';
    const a = document.getElementById('a')!;
    const range = document.createRange();
    range.selectNodeContents(a);
    document.getSelection()!.addRange(range);
    expect(shouldKeepNativeContextMenu(a, document.getSelection())).toBe(true);
    expect(shouldKeepNativeContextMenu(document.getElementById('b'), document.getSelection())).toBe(false);
  });

  it('只 preventDefault、不 stopPropagation：应用自己的右键处理器照常收到', () => {
    document.body.innerHTML = '<div id="x"></div>';
    let got = false;
    document.getElementById('x')!.addEventListener('contextmenu', () => (got = true));
    const off = installNativeContextMenuGuard();
    rightClick(document.getElementById('x')!);
    expect(got).toBe(true);
    off();
  });
});
