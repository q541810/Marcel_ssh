import { useCallback, useContext, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import ContextMenu, { type ContextMenuItem } from '@/components/ui/ContextMenu';
import MobileFileLinkSheet from '@/mobile/MobileFileLinkSheet';
import { useFileMachine, useRelativeCandidates } from '@/hooks/useFileMachine';
import {
  fileBaseName,
  fileLinkActionItems,
  type RelativeCandidate,
  type FileActionId,
  type FileRef,
  type MachineResolution,
} from '@/lib/fileLink';
import {
  canShowFileManager,
  copyWithNotice,
  isMobileShell,
  runDefaultFileAction,
  runFileAction,
} from '@/lib/fileNav';
import { useFileNavStore } from '@/stores/fileNavStore';
import { MessageJumpContext } from './messageJumpContext';

export interface FileLinkBehavior {
  machine: MachineResolution;
  /** 鼠标右键（桌面）/ 长按（手机，WebView 把长按当 contextmenu）都进这里。 */
  onContextMenu: (event: MouseEvent) => void;
  /** 默认动作（左键）；机器不在线时改为提示原因，不静默无事发生。 */
  activate: () => void;
  /** 菜单 / 面板本体，挂在组件树里任意位置（走 portal）。 */
  menu: ReactNode;
}

/**
 * 文件链接与工具卡路径芯片共用的交互：解析机器、左键默认动作、右键 / 长按菜单。
 * 菜单条目来自 `fileLinkActionItems`（桌面右键菜单与手机面板同一份），动作执行都走 `fileNav`。
 */
export function useFileLinkBehavior(file: FileRef): FileLinkBehavior {
  const conversationId = useContext(MessageJumpContext)?.conversationId ?? null;
  const machine = useFileMachine(file, conversationId);
  const mobile = useMemo(() => isMobileShell(), []);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  /** 二级菜单（复制相对路径）的锚点。 */
  const [subAnchor, setSubAnchor] = useState<{ x: number; y: number } | null>(null);
  const menuOpen = anchor !== null || sheetOpen || subAnchor !== null;

  const sessionId = machine.ok ? machine.sessionId : null;
  const relative = useRelativeCandidates(file, sessionId, menuOpen && machine.ok);
  // 文件管理器够不着时（桌面底栏当下无处可开）把借它的项藏起来；菜单每次打开时重新判断。
  // 项目根目录这类要发请求才知道的候选，到了才由 `relative` 带进来——菜单不等它，先出现，
  // 之后多出的「复制相对路径」排在分隔线以下的进阶项里，不挤动上面的常用项。
  const items = useMemo(
    () =>
      fileLinkActionItems(file, {
        relative,
        unresolved: !machine.ok,
        fileManager: !menuOpen || canShowFileManager(),
      }),
    [file, relative, machine.ok, menuOpen],
  );

  const run = useCallback(
    (id: FileActionId) => void runFileAction(id, file, { conversationId }),
    [file, conversationId],
  );

  const activate = useCallback(() => {
    if (!machine.ok) {
      useFileNavStore.getState().notify(machine.reason);
      return;
    }
    void runDefaultFileAction(file, { conversationId });
  }, [machine, file, conversationId]);

  const onContextMenu = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (mobile) setSheetOpen(true);
      else setAnchor({ x: event.clientX, y: event.clientY });
    },
    [mobile],
  );

  const closeMenu = useCallback(() => setAnchor(null), []);
  const closeSub = useCallback(() => setSubAnchor(null), []);
  const copyRelative = useCallback((c: RelativeCandidate) => void copyWithNotice(c.text), []);
  const closeSheet = useCallback(() => setSheetOpen(false), []);

  const menu = mobile ? (
    <MobileFileLinkSheet
      open={sheetOpen}
      onClose={closeSheet}
      title={fileBaseName(file.path)}
      items={items}
      onSelect={run}
      onCopyRelative={copyRelative}
    />
  ) : null;
  const desktopMenu = mobile ? null : anchor ? (
    <ContextMenu
      x={anchor.x}
      y={anchor.y}
      onClose={closeMenu}
      items={items.map<ContextMenuItem>((item) => ({
        label: item.children ? `${item.label} ›` : item.label,
        description: item.hint,
        divider: item.id === 'divider',
        onClick: () => {
          if (item.id === 'divider') return;
          if (item.id === 'copyRelative') {
            // 菜单项点完会关掉一级菜单；二级菜单晚一拍在同一位置打开，避开这次点击的冒泡
            const at = anchor;
            setTimeout(() => setSubAnchor(at), 0);
            return;
          }
          run(item.id);
        },
      }))}
    />
  ) : null;
  const subMenu = !mobile && subAnchor ? (
    <ContextMenu
      x={subAnchor.x}
      y={subAnchor.y}
      onClose={closeSub}
      items={(items.find((i) => i.id === 'copyRelative')?.children ?? []).map<ContextMenuItem>((c) => ({
        label: c.label,
        description: c.text,
        onClick: () => copyRelative(c),
      }))}
    />
  ) : null;

  return {
    machine,
    onContextMenu,
    activate,
    menu: (
      <>
        {menu}
        {desktopMenu}
        {subMenu}
      </>
    ),
  };
}
