/**
 * 屏蔽浏览器自带的右键菜单（刷新 / 另存为 / 检查……）。
 *
 * 这是桌面应用不是网页，在空白处右键弹出「刷新」「检查」只会让人困惑，甚至误点把界面刷掉。
 * 但有两处原生菜单是真有用的，保留：
 *  - 输入框 / 文本域 / 可编辑区：剪切、复制、粘贴、全选、撤销；
 *  - 右键点在已选中的文字上：复制。
 * 应用自己的右键菜单（`ContextMenu`、终端粘贴等）靠各自的 `onContextMenu` / 监听器，
 * 这里只 `preventDefault`、不 `stopPropagation`，所以它们照常工作。
 */

/** 这次右键该不该留给浏览器原生菜单。纯函数，便于测试。 */
export function shouldKeepNativeContextMenu(target: EventTarget | null, selection: Selection | null): boolean {
  if (target instanceof Element) {
    if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return true;
  }
  if (selection && !selection.isCollapsed && selection.toString().trim() !== '' && target instanceof Node) {
    // 只有右键点在选区之内才算「对选中文字右键」，点在别处不算
    for (let i = 0; i < selection.rangeCount; i++) {
      if (selection.getRangeAt(i).intersectsNode(target)) return true;
    }
  }
  return false;
}

/** 安装全局拦截。返回卸载函数。开发模式不装，留着「检查」方便调试。 */
export function installNativeContextMenuGuard(doc: Document = document): () => void {
  const onContextMenu = (event: MouseEvent) => {
    if (shouldKeepNativeContextMenu(event.target, doc.getSelection())) return;
    event.preventDefault();
  };
  // 捕获阶段：不依赖冒泡，也不会被谁的 stopPropagation 漏掉
  doc.addEventListener('contextmenu', onContextMenu, true);
  return () => doc.removeEventListener('contextmenu', onContextMenu, true);
}
