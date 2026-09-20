import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react';
import { useConnectionStore } from '@/stores/connectionStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useSessionLifecycle } from '@/hooks/useSessionLifecycle';
import { useConnectWithPassword } from '@/hooks/useConnectWithPassword';
import { useHostKeyMismatch } from '@/hooks/useHostKeyMismatch';
import { usePrivacyMode } from '@/hooks/usePrivacyMode';
import { asHostKeyMismatch, parseAppError } from '@/lib/errors';
import { isPassphraseProblem, keyNeedsPassphrase } from '@/lib/privateKey';
import { formatConnLabel } from '@/lib/privacy';
import {
  groupConnections,
  groupNameOf,
  moveConnection,
  moveGroup,
  shiftConnection,
  toOrderEntries,
} from '@/lib/connectionOrder';
import type { SavedConnection, ConnectionConfig } from '@/lib/types';
import * as tauri from '@/lib/tauri';
import Modal from '@/components/ui/Modal';
import ListPanel from '@/components/ui/ListPanel';
import ContextMenu from '@/components/ui/ContextMenu';
import ConnectionForm from './ConnectionForm';

/** 拖拽中的落点：落进哪个分组、插在哪条连接之前（null = 该分组末尾）。 */
interface DropTarget {
  group: string;
  beforeId: string | null;
}

/** 被拖拽的对象：一行连接，或整个分组。 */
type DragSubject = { kind: 'row'; id: string } | { kind: 'group'; name: string };

/** 拖拽开始时量下来的几何快照（视口坐标；随内层滚动补偿）。 */
interface RowSlot {
  id: string;
  top: number;
  bottom: number;
}
interface GroupSlot {
  name: string;
  top: number;
  bottom: number;
  headerBottom: number;
}

/** 激活时量下的布局：可见行顺序 / 行槽高 / 分组顺序 / 分组块高。 */
interface DragLayout {
  rowOrder: string[];
  slotHeight: number;
  groupOrder: string[];
  groupHeights: Record<string, number>;
}

/** 组内行的间距与外层分组块的间距（对应下方 `space-y-1` / `space-y-3`）。 */
const ROW_GAP = 4;
const GROUP_GAP = 12;
/** 让位动画的时长与曲线（非手势驱动，可用 CSS 过渡；两个方向同一曲线，进出对称）。 */
const SHIFT_MS = 170;
const SHIFT_EASE = 'cubic-bezier(0.25, 1, 0.5, 1)';
/** 拿起时的抬起反馈时长（只过渡 scale，不碰跟手的 transform）。 */
const LIFT_MS = 150;

/**
 * 落点指示线：用 box-shadow 画，**不占布局**。
 *
 * 早先是一根 2px 的 div，插进列表后会把后面的行整体推下去（线 + 两侧 gap ≈ 6px）——
 * 拖拽过程中每次落点变化都让列表抖一下，被拖的行也跟着漂（实测往上拖会漂 6px）。
 */
const LINE_ABOVE = 'shadow-[0_-2px_0_0_#6366f1]';
const LINE_BELOW = 'shadow-[0_2px_0_0_#6366f1]';

/** 向上找可滚动的祖先，用于拖到列表边缘时自动滚动。 */
function scrollableAncestor(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

export default function ConnectionList() {
  const connections = useConnectionStore((s) => s.connections);
  const loading = useConnectionStore((s) => s.loading);
  const fetchConnections = useConnectionStore((s) => s.fetchConnections);
  const addConnection = useConnectionStore((s) => s.addConnection);
  const removeConnection = useConnectionStore((s) => s.removeConnection);
  const applyConnectionOrder = useConnectionStore((s) => s.applyConnectionOrder);
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);
  const setActiveConnection = useConnectionStore((s) => s.setActiveConnection);
  const connect = useSessionStore((s) => s.connect);
  const connectWithSavedPassword = useSessionStore((s) => s.connectWithSavedPassword);
  const connectWithSavedPassphrase = useSessionStore((s) => s.connectWithSavedPassphrase);
  const { onConnected } = useSessionLifecycle();
  const privacyMode = usePrivacyMode();

  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    connection: SavedConnection;
  } | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingConnection, setEditingConnection] =
    useState<SavedConnection | undefined>(undefined);
  /**
   * 连接前的本地错误（如"这条连接存的认证方式已不支持"）。
   *
   * 连接失败本身有终端横幅兜着（失败会话会把详细信息打上去），但**还没开始连就
   * 走不下去**的情况以前只写进 console，用户那边什么都不显示。移动端一直有这条
   * 红条，桌面补齐成同一套。
   */
  const [localError, setLocalError] = useState<string | null>(null);
  // 拖拽排序状态：拖连接、拖分组各一套落点
  const [dragSubject, setDragSubject] = useState<DragSubject | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // 拖分组时的落点：挪到哪个分组之前（null = 挪到最后，undefined = 还没落到任何位置）
  const [groupDropTarget, setGroupDropTarget] = useState<string | null | undefined>(undefined);
  // 拖拽用的 ref（避免 mousemove 每次都走一次渲染）
  const dragSubjectRef = useRef<DragSubject | null>(null);
  const pendingDragRef = useRef<{ subject: DragSubject; x: number; y: number } | null>(null);
  const draggedElRef = useRef<HTMLElement | null>(null);
  const startYRef = useRef(0);
  const suppressClickUntilRef = useRef(0);
  const autoScrollRef = useRef<number | null>(null);
  const autoScrollSpeedRef = useRef(0);
  const autoScrollDwellRef = useRef<number | null>(null);
  // 落点的权威来源：state 只负责渲染，**提交一律读 ref**
  // （mouseup 可能赶在最后一次 mousemove 的 state 提交之前，读 state 会用到过期落点）
  const dropTargetRef = useRef<DropTarget | null>(null);
  const groupDropTargetRef = useRef<string | null | undefined>(undefined);
  const geometryRef = useRef<{
    rows: RowSlot[];
    groups: GroupSlot[];
    scrolled: number;
    scroller: HTMLElement | null;
  } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /**
   * 让位动画的输入：激活时量下来的可见顺序与槽位高度。
   *
   * 动画分工（按 apple-design 的口径）：
   * - 被拖的行是**手势驱动**的 → 1:1 跟手、零过渡（有过渡就抓不住、还会拖尾/回弹）；
   * - 其余行是**非手势驱动**的 → 由这里算出该让出/补上多少位移，用短过渡平滑滑过去。
   *   这才是"拖拽动画"该出现的地方，而且两个方向对称。
   */
  const [dragLayout, setDragLayout] = useState<DragLayout | null>(null);
  /** 松手落位这一拍要关掉过渡，否则新顺序与归零位移会互相打架、看着像闪一下 */
  const [settling, setSettling] = useState(false);
  const reducedMotionRef = useRef(false);
  useEffect(() => {
    reducedMotionRef.current =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);
  const { prompt: promptPassword, Prompt: PasswordPromptEl } = useConnectWithPassword();
  const mismatch = useHostKeyMismatch();

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  const filteredConnections = connections.filter(
    (c) =>
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.host.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const isFiltering = searchQuery.trim().length > 0;

  // 分组（组顺序 = 首次出现；组内保持数组顺序）
  const grouped = useMemo(() => groupConnections(filteredConnections), [filteredConnections]);
  const allGroupNames = useMemo(
    () => groupConnections(connections).map((g) => g.name),
    [connections],
  );

  const commitOrder = useCallback(
    (next: SavedConnection[]) => {
      if (next === connections) return;
      const entries = toOrderEntries(next);
      const current = toOrderEntries(connections);
      const unchanged =
        entries.length === current.length &&
        entries.every(
          (e, i) => e.id === current[i].id && (e.group ?? null) === (current[i].group ?? null),
        );
      if (unchanged) return;
      void applyConnectionOrder(entries);
    },
    [applyConnectionOrder, connections],
  );

  const resetDrag = useCallback(() => {
    const el = draggedElRef.current;
    if (el) {
      el.style.transition = 'none';
      el.style.transform = '';
      el.style.scale = '';
      el.style.pointerEvents = '';
      // 先把复位按"零过渡"落定，再还原过渡（否则这次复位会被过渡动画接管）
      void el.offsetHeight;
      el.style.transition = '';
    }
    dragSubjectRef.current = null;
    pendingDragRef.current = null;
    draggedElRef.current = null;
    setDragLayout(null);
    setDragSubject(null);
    dropTargetRef.current = null;
    groupDropTargetRef.current = undefined;
    geometryRef.current = null;
    setDropTarget(null);
    setGroupDropTarget(undefined);
    document.body.style.userSelect = '';
  }, []);

  // ── 拖拽：指针事件实现（**不是** HTML5 drag-and-drop）──
  //
  // Windows 上 Tauri 默认 `dragDropEnabled: true`，会在原生层截走 HTML5 拖拽事件
  // （官方 schema：Disabling it is required to use HTML5 drag and drop on the frontend
  // on Windows），应用内文件拖入上传正依赖那个拦截，不能关。所以列表排序改用
  // mousedown/mousemove 自己实现，绕开 OS 级拖放。

  /** 拖连接时它所属的分组；拖分组时就是被拖的组名。 */
  const draggedGroup = useMemo(() => {
    if (!dragSubject) return null;
    return dragSubject.kind === 'group'
      ? dragSubject.name
      : groupNameOf(connections.find((c) => c.id === dragSubject.id) ?? {});
  }, [connections, dragSubject]);

  /** 过滤状态下可见序列 ≠ 完整序列，跨组移入会把被过滤掉的项一起搬走，故只允许同组重排。 */
  const canDropIntoGroup = useCallback(
    (group: string) => dragSubject != null && (!isFiltering || group === draggedGroup),
    [dragSubject, draggedGroup, isFiltering],
  );

  const commitDrop = useCallback(() => {
    const subject = dragSubjectRef.current;
    if (subject?.kind === 'group') {
      setSettling(true);
      const anchor = groupDropTargetRef.current;
      // undefined = 没落到任何分组上 → 不提交，原样还原（避免误拖把分组甩到最后）
      if (anchor !== undefined) {
        commitOrder(moveGroup(connections, { groupName: subject.name, beforeGroupName: anchor }));
      }
    } else if (subject) {
      const target = dropTargetRef.current;
      if (target) {
        setSettling(true);
        commitOrder(
          moveConnection(connections, {
            dragId: subject.id,
            toGroup: target.group,
            beforeId: target.beforeId,
          }),
        );
      }
    }
    resetDrag();
    if (dragSubjectRef.current == null) {
      // 落位后两帧再恢复让位过渡（此时新顺序已渲染）
      requestAnimationFrame(() => requestAnimationFrame(() => setSettling(false)));
    }
  }, [commitOrder, connections, resetDrag]);

  /**
   * 拖拽开始时量一次几何位置，之后靠坐标而不是命中测试算落点。
   *
   * 为什么不用 `document.elementFromPoint`：行与行之间有 4px 间隙、分组块还有内边距，
   * 指针落在这些"缝"里时会命中分组容器，被当成"落到该组末尾"——表现就是**拖到中间却
   * 莫名其妙跳到底下**。另外被拖的行会跟着指针走，命中测试还得额外排除它自己。
   */
  const measureDragGeometry = useCallback(() => {
    const root = listRef.current;
    if (!root) return;
    const scroller = scrollableAncestor(root);
    const rows: RowSlot[] = [];
    for (const el of root.querySelectorAll<HTMLElement>('[data-conn-id]')) {
      const rect = el.getBoundingClientRect();
      rows.push({
        id: el.dataset.connId!,
        top: rect.top,
        bottom: rect.bottom,
      });
    }
    const groups: GroupSlot[] = [];
    for (const el of root.querySelectorAll<HTMLElement>('[data-group-block]')) {
      const rect = el.getBoundingClientRect();
      const header = el.querySelector<HTMLElement>('[data-group-name]');
      const headerRect = header?.getBoundingClientRect();
      groups.push({
        name: el.dataset.groupBlock!,
        top: rect.top,
        bottom: rect.bottom,
        headerBottom: headerRect?.bottom ?? rect.top,
      });
    }
    geometryRef.current = {
      rows,
      groups,
      scrolled: scroller?.scrollTop ?? 0,
      scroller,
    };

    const draggedId = dragSubjectRef.current?.kind === 'row' ? dragSubjectRef.current.id : null;
    const draggedRow = draggedId ? rows.find((r) => r.id === draggedId) : null;
    const draggedGroup =
      dragSubjectRef.current?.kind === 'group' ? dragSubjectRef.current.name : null;
    const draggedBlock = draggedGroup ? groups.find((g) => g.name === draggedGroup) : null;
    const groupHeights: Record<string, number> = {};
    for (const g of groups) groupHeights[g.name] = g.bottom - g.top;
    setDragLayout({
      rowOrder: rows.map((r) => r.id),
      // 槽位高度 = 被拖元素的高度 + 它占用的那层间距：拖行加组内 space-y-1，
      // 拖分组加组间 space-y-3。少了这段间距，别人让位就会差一个间距、松手时再弹一下
      slotHeight: draggedRow
        ? draggedRow.bottom - draggedRow.top + ROW_GAP
        : (draggedBlock?.bottom ?? 0) - (draggedBlock?.top ?? 0) + GROUP_GAP,
      groupOrder: groups.map((g) => g.name),
      groupHeights,
    });
  }, []);

  /**
   * 指针落在哪个分组区间：优先包含它的那个；落在分组之间的间隔里时取**垂直最近**的
   * 那个（不能一律当成最后一个，否则在间隔里松手会被甩到列表底部）。
   */
  const resolveGroupSlot = useCallback((geo: { groups: GroupSlot[] }, y: number): GroupSlot => {
    const inside = geo.groups.find((g) => y >= g.top && y <= g.bottom);
    if (inside) return inside;
    const distance = (g: GroupSlot) => (y < g.top ? g.top - y : y > g.bottom ? y - g.bottom : 0);
    return geo.groups.reduce((best, g) => (distance(g) < distance(best) ? g : best));
  }, []);

  /** 指针的 clientY → 激活时坐标系下的 y（补偿拖拽期间内层容器的滚动）。 */
  const normalizePointerY = useCallback((clientY: number): number => {
    const geo = geometryRef.current;
    if (!geo) return clientY;
    const delta = (geo.scroller?.scrollTop ?? 0) - geo.scrolled;
    return clientY + delta;
  }, []);

  const updateDropTargetFromPoint = useCallback(
    (clientY: number, subject: DragSubject) => {
      const geo = geometryRef.current;
      if (!geo || geo.groups.length === 0) return;
      const y = normalizePointerY(clientY);

      if (subject.kind === 'group') {
        // 落在哪个分组区间就相对它前/后（用标题中线判断），组内容区一律算"排到它后面"
        const slot = resolveGroupSlot(geo, y);
        if (slot.name === subject.name) return;
        const headerMid = (slot.top + slot.headerBottom) / 2;
        const rest = allGroupNames.filter((n) => n !== subject.name);
        const idx = rest.indexOf(slot.name);
        const next = y < headerMid ? slot.name : (rest[idx + 1] ?? null);
        groupDropTargetRef.current = next;
        setGroupDropTarget(next);
        dropTargetRef.current = null;
        setDropTarget(null);
        return;
      }

      // 拖连接：先定位分组区间，再在组内按行的中线找插入位。
      const groupSlot = resolveGroupSlot(geo, y);
      const group = groupSlot.name;
      if (!canDropIntoGroup(group)) return;

      // `siblings` 必须排除**被拖的那一行自己**：几何快照里它还在原位，指针压在它
      // 自己的上半部时算出来的插入位就是它，于是 `beforeId === dragId` —— 而它已被
      // `moveConnection` 滤掉，锚点找不到就会落进"末尾"兜底，把行甩到组尾（单成员
      // 分组时整个分组跳到列表末尾），同时画面上毫无提示。详见 `moveConnection`。
      const siblings = geo.rows.filter(
        (row) =>
          row.id !== subject.id &&
          groupNameOf(connections.find((c) => c.id === row.id) ?? {}) === group,
      );
      const next = siblings.find((row) => y < (row.top + row.bottom) / 2);
      const target = { group, beforeId: next?.id ?? null };
      dropTargetRef.current = target;
      setDropTarget(target);
    },
    [allGroupNames, canDropIntoGroup, connections, normalizePointerY, resolveGroupSlot],
  );

  /**
   * 让位位移：把"空档"从原位置搬到落点。
   *
   * 规则 = 撤走原空档（原位置之后整体上移 H） + 在落点开个空档（该位置及之后整体下移 H）；
   * 两项在区间之外自然抵消，所以只有「原位置 ↔ 落点」之间的元素会动，其余纹丝不动。
   * 往上拖与往下拖走同一套公式，动画因此对称。
   */
  const computeShifts = useCallback(
    (
      subjectIndex: number,
      insertIndex: number,
      slotHeight: number,
      order: string[],
    ): Map<string, number> => {
      const shifts = new Map<string, number>();
      if (subjectIndex === -1 || insertIndex === -1 || order.length === 0) return shifts;
      order.forEach((id, i) => {
        if (i === subjectIndex) return;
        let shift = 0;
        if (i > subjectIndex) shift -= slotHeight;
        if (i >= insertIndex) shift += slotHeight;
        if (shift !== 0) shifts.set(id, shift);
      });
      return shifts;
    },
    [],
  );

  /** 拖连接时各行的让位位移。 */
  const rowShifts = useMemo(() => {
    if (!dragSubject || dragSubject.kind !== 'row' || !dragLayout || !dropTarget) {
      return new Map<string, number>();
    }
    const order = dragLayout.rowOrder;
    const origin = order.indexOf(dragSubject.id);
    let insert: number;
    if (dropTarget.beforeId) {
      insert = order.indexOf(dropTarget.beforeId);
    } else {
      // 落到分组末尾 = 该组最后一行之后的位置
      const items = grouped.find((g) => g.name === dropTarget.group)?.items ?? [];
      const lastId = items[items.length - 1]?.id;
      insert = lastId ? order.indexOf(lastId) + 1 : order.length;
    }
    return computeShifts(origin, insert, dragLayout.slotHeight, order);
  }, [computeShifts, dragLayout, dragSubject, dropTarget, grouped]);

  /** 拖分组时各分组块的让位位移。 */
  const groupShifts = useMemo(() => {
    if (!dragSubject || dragSubject.kind !== 'group' || !dragLayout) {
      return new Map<string, number>();
    }
    const order = dragLayout.groupOrder;
    const origin = order.indexOf(dragSubject.name);
    const insert = groupDropTarget == null ? order.length : order.indexOf(groupDropTarget);
    const height = dragLayout.groupHeights[dragSubject.name] ?? 0;
    return computeShifts(origin, insert, height, order);
  }, [computeShifts, dragLayout, dragSubject, groupDropTarget]);

  /**
   * 拖**连接**时各分组块的位移（只有跨组拖拽用得上）。
   *
   * `rowShifts` 把列表当成一整条流水算，行因此落在正确的绝对位置上；但分组标题不在
   * 那条流水里——它跟着自己那块走。跨组拖拽会改块高（源块少一行就短 H、目标块多一行
   * 就长 H），块整体因此要挪：排在源块之后的块先上移 H，排在目标块之后的再上移回来。
   * 少了这一步，标题与高亮框会原地不动、松手瞬间「啪」地跳一格（实测跨组时 58px）。
   *
   * 源块自己例外：它内部包含跟着指针走的被拖行，整块位移会把那一行也带走，
   * 所以源块改成「标题单独平移、整块不动」，行仍按绝对位移走（见 render）。
   */
  const blockShifts = useMemo(() => {
    const shifts = new Map<string, number>();
    if (dragSubject?.kind !== 'row' || !dragLayout || !dropTarget || !draggedGroup) return shifts;
    const order = dragLayout.groupOrder;
    const source = order.indexOf(draggedGroup);
    const target = order.indexOf(dropTarget.group);
    if (source === -1 || target === -1 || source === target) return shifts;
    const height = dragLayout.slotHeight;
    order.forEach((name, i) => {
      const shift = (i > source ? -height : 0) + (i > target ? height : 0);
      if (shift !== 0) shifts.set(name, shift);
    });
    return shifts;
  }, [dragLayout, dragSubject, draggedGroup, dropTarget]);

  /**
   * 某个分组块的位移。
   *
   * 拖分组 = 整块搬移（`groupShifts`）；拖连接时源块不动（被拖行在里面），
   * 由标题与行分别平移实现。
   */
  const blockOffset = useCallback(
    (name: string): number | undefined =>
      dragSubject?.kind === 'group'
        ? groupShifts.get(name)
        : name === draggedGroup
          ? undefined
          : blockShifts.get(name),
    [blockShifts, draggedGroup, dragSubject, groupShifts],
  );

  /** 源块的标题位移：块没动，所以标题得自己挪（跨组时源块的标题也要跟着走）。 */
  const headerOffset = useCallback(
    (name: string): number | undefined =>
      dragSubject?.kind === 'row' && name === draggedGroup ? blockShifts.get(name) : undefined,
    [blockShifts, draggedGroup, dragSubject],
  );

  /**
   * 行自己的位移 = 绝对让位位移 − 所在块承担的位移（块动了，行就不用再动那么多）。
   *
   * 「绝对位移是 0 的行」不在 `rowShifts` 里（省得给没动的行挂样式），但它的块要是动了，
   * 它仍然需要反向补回来——比如跨组往下拖时，目标组里排在落点之后的那一行绝对位置不变，
   * 而它所在的块整体上移了，少了这个补偿它就会跟着块一起往上跑。
   */
  const rowOffset = useCallback(
    (conn: SavedConnection): number | undefined => {
      if (dragSubject?.kind !== 'row' || !dropTarget) return undefined;
      const group = groupNameOf(conn);
      const block = group === draggedGroup ? 0 : (blockShifts.get(group) ?? 0);
      const shift = (rowShifts.get(conn.id) ?? 0) - block;
      return shift === 0 ? undefined : shift;
    },
    [blockShifts, dragSubject, draggedGroup, dropTarget, rowShifts],
  );

  /**
   * 让位元素的过渡样式。
   *
   * 让位是**非手势驱动**的位移，所以用 CSS 过渡（手势驱动的跟随另有一套：零过渡 1:1 跟手）。
   * 松手落位那一拍要关掉过渡，否则「新顺序 + 位移归零」会互相打架看着像闪一下；
   * `prefers-reduced-motion` 下直接不animate（Apple 的无障碍口径：减少动态不等于没有反馈）。
   */
  const shiftStyle = useCallback(
    (shift: number | undefined): React.CSSProperties | undefined => {
      if (shift == null) return undefined;
      return {
        transform: `translateY(${shift}px)`,
        transition:
          settling || reducedMotionRef.current
            ? 'none'
            : `transform ${SHIFT_MS}ms ${SHIFT_EASE}`,
      };
    },
    [settling],
  );

  const startPointerDrag = useCallback(
    (subject: DragSubject) => (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const el = e.currentTarget as HTMLElement;
      // 拖分组时让**整个分组块**跟着走（不是只有标题），视觉上才说得通
      const followEl =
        subject.kind === 'group'
          ? el.closest('[data-group-block]')
          : el.closest('[data-conn-id]');
      draggedElRef.current = (followEl ?? el) as HTMLElement;
      startYRef.current = e.clientY;
      pendingDragRef.current = { subject, x: e.clientX, y: e.clientY };
    },
    [],
  );

  /**
   * 拖到列表上下边缘附近时自动滚动（rAF 循环，指针停住也继续滚）。
   *
   * 边缘窄一点、速度慢一点、且在边缘**停留一下**才启动：侧边栏本身不高，边缘带太宽
   * 会让「只是从边上经过」也触发滚动，把落点一路带到底部——看起来就是「莫名其妙跳到底下」。
   */
  const updateAutoScroll = useCallback((clientY: number) => {
    const container = scrollableAncestor(draggedElRef.current);
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const EDGE = 28;
    const MAX_STEP = 8;
    const DWELL_MS = 120;
    let speed = 0;
    if (clientY < rect.top + EDGE) {
      speed = -Math.ceil((rect.top + EDGE - clientY) / 4);
    } else if (clientY > rect.bottom - EDGE) {
      speed = Math.ceil((clientY - (rect.bottom - EDGE)) / 4);
    }
    autoScrollSpeedRef.current = Math.max(-MAX_STEP, Math.min(MAX_STEP, speed));
    if (autoScrollSpeedRef.current === 0) {
      autoScrollDwellRef.current = null;
      return;
    }
    // 先记下进入边缘的时刻，停留够 DWELL_MS 再开始滚动
    if (autoScrollDwellRef.current == null) {
      autoScrollDwellRef.current = Date.now();
      return;
    }
    if (Date.now() - autoScrollDwellRef.current < DWELL_MS) return;
    if (autoScrollRef.current != null) return;
    const step = () => {
      const box = scrollableAncestor(draggedElRef.current);
      if (!box || autoScrollSpeedRef.current === 0) {
        autoScrollRef.current = null;
        return;
      }
      box.scrollBy(0, autoScrollSpeedRef.current);
      autoScrollRef.current = requestAnimationFrame(step);
    };
    autoScrollRef.current = requestAnimationFrame(step);
  }, []);

  const stopAutoScroll = useCallback(() => {
    autoScrollSpeedRef.current = 0;
    autoScrollDwellRef.current = null;
    if (autoScrollRef.current != null) {
      cancelAnimationFrame(autoScrollRef.current);
      autoScrollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopAutoScroll(), [stopAutoScroll]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const pending = pendingDragRef.current;
      if (pending && !dragSubjectRef.current) {
        // 位移阈值：避免把普通点击当成拖拽
        if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < 4) return;
        dragSubjectRef.current = pending.subject;
        suppressClickUntilRef.current = Date.now() + 300;
        document.body.style.userSelect = 'none';
        // 被拖的行跟着指针走：
        // - pointer-events:none 让命中测试跳过它自己
        // - transition:none 是必须的：行是 <button>，全局样式给所有 button 挂了
        //   200ms 弹簧过渡（含 transform），不关掉就会"拖尾"，往上拖还会因为回弹型
        //   缓动冲过目标再弹回来（实测往下拖 60ms 后仍滞后 8px、往上拖 320ms 后仍超 6px）
        // 几何快照要在加抬起 scale **之前**量：getBoundingClientRect 带变换，放大 1.03 后
        // 量出来的行高也多 3%，会让其他行的让位距离整体偏出一点点
        measureDragGeometry();
        if (draggedElRef.current) {
          draggedElRef.current.style.pointerEvents = 'none';
          // transform 必须零过渡（1:1 跟手，否则拖尾/回弹）；只给"抬起"的 scale 留过渡
          draggedElRef.current.style.transition = `scale ${LIFT_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
          draggedElRef.current.style.scale = reducedMotionRef.current ? '' : '1.03';
        }
        setDragSubject(pending.subject);
      }
      const subject = dragSubjectRef.current;
      if (!subject) return;
      const dy = e.clientY - startYRef.current;
      if (draggedElRef.current) {
        draggedElRef.current.style.transform = `translateY(${Math.round(dy)}px)`;
      }
      updateDropTargetFromPoint(e.clientY, subject);
      updateAutoScroll(e.clientY);
    };
    const onUp = () => {
      pendingDragRef.current = null;
      stopAutoScroll();
      if (dragSubjectRef.current) commitDrop();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [commitDrop, measureDragGeometry, stopAutoScroll, updateAutoScroll, updateDropTargetFromPoint]);

  /**
   * Attempt to connect with the given password (or no password for non-Password
   * methods). On password-auth failure with a saved password, the stored entry
   * is purged and the user is prompted to re-enter.
   *
   * `trust` is only set true on the retry path after the user confirms the
   * HostKeyMismatch modal — it drives `KnownHostsStore::replace` in the
   * backend so the stored fingerprint is overwritten rather than rejected.
   */
  const doConnect = async (
    conn: SavedConnection,
    password?: string,
    passphrase?: string,
    trust = false,
  ) => {
    let authMethod: ConnectionConfig['authMethod'];
    switch (conn.authMethod) {
      case 'Password':
        if (!password) {
          promptForPassword(conn);
          return;
        }
        authMethod = { type: 'Password', password };
        break;
      case 'PrivateKey':
        authMethod = {
          type: 'PrivateKey',
          keyId: conn.keyId,
          keyPath: conn.keyPath,
          passphrase,
        };
        break;
      default:
        // 历史数据里可能有已不再支持的取值（例如早期的 "Agent"）：
        // 说清楚是哪一条、该怎么修，而不是发一个后端必然拒绝的请求
        setLocalError(
          `「${conn.name}」保存的认证方式（${conn.authMethod}）已不再支持，请编辑这条连接、重新选择认证方式`,
        );
        return;
    }
    // Jump secrets are loaded on the Rust side from keychain when connectionId is set.
    const config: ConnectionConfig = {
      host: conn.host,
      port: conn.port,
      username: conn.username,
      authMethod,
      connectionId: conn.id,
      trustNewHostKey: trust,
    };
    try {
      const sessionId = await connect(config);
      if (config.connectionId) {
        onConnected(config.connectionId, sessionId);
      }
    } catch (err) {
      if (!trust) {
        const m = asHostKeyMismatch(parseAppError(err));
        if (m) {
          mismatch.prompt({
            data: m,
            onTrust: () => doConnect(conn, password, passphrase, true),
          });
          return;
        }
      }
      console.error('连接失败:', err);
    }
  };

  const promptForPassword = (conn: SavedConnection) => {
    promptPassword({
      title: 'SSH 密码',
      description: `连接到 ${formatConnLabel(conn.username, conn.host, conn.port, privacyMode)}`,
      allowRemember: true,
      onSubmit: async (password, remember) => {
        if (remember) {
          try {
            await tauri.savePassword(conn.id, password);
          } catch (err) {
            console.warn('保存密码到密钥链失败:', err);
          }
        }
        await doConnect(conn, password);
      },
    });
  };

  const promptForPassphrase = (conn: SavedConnection) => {
    promptPassword({
      title: '私钥密码',
      description: `连接到 ${conn.username}@${conn.host}:${conn.port}`,
      allowRemember: true,
      onSubmit: async (passphrase, remember) => {
        if (remember) {
          try {
            await tauri.savePassphrase(conn.id, passphrase);
          } catch (err) {
            console.warn('保存 passphrase 到密钥链失败:', err);
          }
        }
        await doConnect(conn, undefined, passphrase);
      },
    });
  };

  /**
   * Click handler for a saved connection. For password-auth connections,
   * checks if a password is saved in the OS keychain. If so, connects via
   * a Rust-side command that reads the password from the keychain without
   * exposing it to the WebView. Otherwise prompts the user.
   */
  const handleConnect = async (connection: SavedConnection) => {
    setLocalError(null);
    if (connection.authMethod === 'Password') {
      try {
        const stored = await tauri.hasPassword(connection.id);
        if (stored) {
          const connLabel = formatConnLabel(connection.username, connection.host, connection.port, privacyMode);
          try {
            const sessionId = await connectWithSavedPassword(connection.id, connLabel);
            if (connection.id) {
              onConnected(connection.id, sessionId);
            }
            return;
          } catch (err) {
            const m = asHostKeyMismatch(parseAppError(err));
            if (m) {
              mismatch.prompt({
                data: m,
                onTrust: async () => {
                  try {
                    const sid = await connectWithSavedPassword(connection.id, connLabel, true);
                    if (connection.id) onConnected(connection.id, sid);
                  } catch (e) {
                    console.error('连接失败:', e);
                  }
                },
              });
              return;
            }
            console.warn('连接失败:', err);
            return;
          }
        }
      } catch (err) {
        console.warn('检查已保存密码失败:', err);
      }
      promptForPassword(connection);
      return;
    }
    if (connection.authMethod === 'PrivateKey') {
      setLocalError(null);
      const hasSavedPassphrase = await tauri.hasPassphrase(connection.id).catch((err) => {
        console.warn('检查已保存 passphrase 失败:', err);
        return false;
      });

      if (hasSavedPassphrase) {
        const connLabel = formatConnLabel(connection.username, connection.host, connection.port, privacyMode);
        try {
          const sessionId = await connectWithSavedPassphrase(connection.id, connLabel);
          onConnected(connection.id, sessionId);
          return;
        } catch (err) {
          const m = asHostKeyMismatch(parseAppError(err));
          if (m) {
            mismatch.prompt({
              data: m,
              onTrust: async () => {
                try {
                  const sid = await connectWithSavedPassphrase(connection.id, connLabel, true);
                  onConnected(connection.id, sid);
                } catch (e) {
                  console.error('连接失败:', e);
                }
              },
            });
            return;
          }
          // 真需要密码（保存的那把已经不对了）才追问；别的原因就说别的
          if (isPassphraseProblem(err)) {
            promptForPassphrase(connection);
            return;
          }
          console.warn('私钥连接失败:', err);
          return;
        }
      }

      // 密钥库里的私钥是带密码的、而本地没存：直接问，不拿一次失败去试
      if (await keyNeedsPassphrase(connection)) {
        promptForPassphrase(connection);
        return;
      }

      try {
        const config: ConnectionConfig = {
          host: connection.host,
          port: connection.port,
          username: connection.username,
          authMethod: {
            type: 'PrivateKey',
            keyId: connection.keyId,
            keyPath: connection.keyPath,
          },
          connectionId: connection.id,
        };
        const sessionId = await connect(config);
        if (connection.id) {
          onConnected(connection.id, sessionId);
        }
        return;
      } catch (err) {
        const m = asHostKeyMismatch(parseAppError(err));
        if (m) {
          mismatch.prompt({
            data: m,
            onTrust: () => doConnect(
              connection,
              undefined,
              undefined,
              true,
            ),
          });
          return;
        }
        // 这一次尝试不是白费的：后端明确告诉我们原因，只有"缺密码 / 密码错"
        // 才继续追问，其他原因（文件没了、格式不认、服务器拒绝）照实显示
        if (isPassphraseProblem(err)) {
          promptForPassphrase(connection);
          return;
        }
        console.warn('私钥连接失败:', err);
      }
      return;
    }
    await doConnect(connection);
  };

  const handleContextMenu = (e: React.MouseEvent, connection: SavedConnection) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, connection });
  };

  const closeContextMenu = () => setContextMenu(null);

  const handleSave = async (saved: SavedConnection) => {
    await addConnection(saved);
    setFormOpen(false);
    setEditingConnection(undefined);
  };

  const openNewConnectionForm = () => {
    setEditingConnection(undefined);
    setFormOpen(true);
  };

  const openEditForm = (conn: SavedConnection) => {
    setEditingConnection(conn);
    setFormOpen(true);
    closeContextMenu();
  };

  /** 右键菜单里的上移/下移：只在组内有邻居时才出现（与 SkillList 同一口径）。 */
  const shiftable = useMemo(() => {
    if (!contextMenu) return { up: false, down: false };
    const groupName = groupNameOf(contextMenu.connection);
    const siblings = connections.filter((c) => groupNameOf(c) === groupName);
    const index = siblings.findIndex((c) => c.id === contextMenu.connection.id);
    return { up: index > 0, down: index >= 0 && index < siblings.length - 1 };
  }, [connections, contextMenu]);

  const contextMenuItems = contextMenu
    ? [
        {
          label: '连接',
          onClick: () => handleConnect(contextMenu.connection),
        },
        {
          label: '编辑',
          onClick: () => openEditForm(contextMenu.connection),
        },
        ...(shiftable.up
          ? [
              {
                label: '上移',
                onClick: () => {
                  commitOrder(shiftConnection(connections, { id: contextMenu.connection.id, delta: -1 }));
                  closeContextMenu();
                },
              },
            ]
          : []),
        ...(shiftable.down
          ? [
              {
                label: '下移',
                onClick: () => {
                  commitOrder(shiftConnection(connections, { id: contextMenu.connection.id, delta: 1 }));
                  closeContextMenu();
                },
              },
            ]
          : []),
        { divider: true } as { label: string; onClick: () => void; variant?: 'default' | 'danger'; divider?: boolean },
        {
          label: '删除',
          variant: 'danger' as const,
          onClick: () => {
            if (confirm(`确定要删除连接 "${contextMenu.connection.name}" 吗？`)) {
              removeConnection(contextMenu.connection.id);
            }
          },
        },
      ]
    : [];

  return (
    <ListPanel
      data-region="sessions"
      title="已保存的连接"
      onAdd={openNewConnectionForm}
      addButtonTitle="新建连接"
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      searchPlaceholder="搜索连接..."
    >
      <div ref={listRef} className="space-y-3" onClick={closeContextMenu}>
        {localError && (
          <div
            role="alert"
            className="flex items-start justify-between gap-2 rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs leading-relaxed text-red-300"
          >
            <span>{localError}</span>
            <button
              type="button"
              onClick={() => setLocalError(null)}
              className="shrink-0 text-red-400/70 hover:text-red-200"
              aria-label="关闭提示"
            >
              &times;
            </button>
          </div>
        )}
        {loading && (
          <p className="text-sm text-zinc-500 text-center mt-4">加载中...</p>
        )}
        {!loading && filteredConnections.length === 0 && (
          <div className="text-center mt-6 px-2">
            <p className="text-sm text-zinc-500 mb-3">暂无已保存的连接</p>
            <button
              onClick={openNewConnectionForm}
              className="text-xs text-indigo-400 hover:text-indigo-300 underline"
            >
              点击此处新建连接
            </button>
          </div>
        )}
        {grouped.map((group, groupIndex) => {
          const isLastGroup = groupIndex === grouped.length - 1;
          const lastItemId = group.items[group.items.length - 1]?.id ?? null;
          const isDropGroup =
            dragSubject?.kind === 'row' &&
            dropTarget?.group === group.name &&
            group.name !== draggedGroup;
          const groupLine =
            dragSubject?.kind === 'group'
              ? groupDropTarget === group.name
                ? 'above'
                : groupDropTarget === null && isLastGroup
                  ? 'below'
                  : null
              : null;
          return (
            <Fragment key={group.name}>
              <div
                data-group-block={group.name}
                style={shiftStyle(blockOffset(group.name))}
                className={`rounded-lg ${
                  dragSubject?.kind === 'group' && dragSubject.name === group.name
                    ? 'relative z-10 shadow-2xl shadow-black/50 ring-1 ring-indigo-500/50'
                    : ''
                } ${isDropGroup ? 'bg-indigo-500/5 ring-1 ring-indigo-500/40' : ''}`}
              >
                <h3
                  data-group-name={group.name}
                  style={shiftStyle(headerOffset(group.name))}
                  onMouseDown={
                    isFiltering ? undefined : startPointerDrag({ kind: 'group', name: group.name })
                  }
                  title={isFiltering ? undefined : '拖动分组标题可调整分组顺序'}
                  className={`text-xs font-semibold text-zinc-500 uppercase tracking-wider px-2 mb-1 ${
                    isFiltering ? '' : 'cursor-grab active:cursor-grabbing'
                  } ${
                    dragSubject?.kind === 'group' && dragSubject.name === group.name
                      ? 'opacity-40'
                      : ''
                  } ${groupLine === 'above' ? LINE_ABOVE : ''}`}
                >
                  {group.name}
                </h3>
                <div className="space-y-1">
                  {group.items.map((conn, indexInGroup) => {
                    const rowLine =
                      dragSubject?.kind === 'row' && dropTarget?.group === group.name
                        ? dropTarget.beforeId === conn.id
                          ? 'above'
                          : dropTarget.beforeId === null && indexInGroup === group.items.length - 1
                            ? 'below'
                            : null
                        : null;
                    const line = rowLine ?? (groupLine === 'below' && conn.id === lastItemId ? 'below' : null);
                    return (
                      <button
                        key={conn.id}
                        data-conn-id={conn.id}
                        style={shiftStyle(rowOffset(conn))}
                        onClick={() => {
                          // 拖拽松手后的合成点击要忽略，否则一拖就顺带连上了
                          if (Date.now() < suppressClickUntilRef.current) return;
                          handleConnect(conn);
                        }}
                        onContextMenu={(e) => handleContextMenu(e, conn)}
                        onMouseDown={startPointerDrag({ kind: 'row', id: conn.id })}
                        className={`
                    w-full text-left px-2 py-2 rounded-lg text-sm transition-colors border
                    ${
                      dragSubject?.kind === 'row' && dragSubject.id === conn.id
                        ? 'opacity-40 relative z-10'
                        : ''
                    }
                    ${line === 'above' ? LINE_ABOVE : line === 'below' ? LINE_BELOW : ''}
                    ${
                      activeConnectionId === conn.id
                        ? 'bg-indigo-900/30 border-indigo-700'
                        : 'bg-zinc-900/40 border-zinc-800 hover:border-zinc-700'
                    }
                  `}
                      >
                        <div className="font-medium text-zinc-200 truncate">
                          {conn.name}
                        </div>
                        <div className="text-xs text-zinc-500 truncate">
                          {formatConnLabel(conn.username, conn.host, conn.port, privacyMode)}
                        </div>
                        {conn.lastConnected && (
                          <div className="text-xs text-zinc-600 mt-0.5">
                            上次连接：{new Date(conn.lastConnected).toLocaleDateString()}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </Fragment>
          );
        })}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={closeContextMenu}
        />
      )}

      {/* New / Edit connection modal */}
      <Modal
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditingConnection(undefined);
        }}
        title={editingConnection ? '编辑连接' : '新建连接'}
      >
        <ConnectionForm
          connection={editingConnection}
          onSave={handleSave}
          onCancel={() => {
            setFormOpen(false);
            setEditingConnection(undefined);
          }}
        />
      </Modal>

      {/* Password prompt */}
      {PasswordPromptEl}

      {/* Host key mismatch prompt */}
      {mismatch.Modal}
    </ListPanel>
  );
}
