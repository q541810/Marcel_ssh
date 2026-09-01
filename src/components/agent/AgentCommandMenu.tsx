import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { AgentMode } from '@/lib/types';
import { useSkillStore } from '@/stores/skillStore';
import { useAnimatedPresence } from '@/hooks/useAnimatedPresence';
import {
  type MenuEntry,
  buildAgentCommandEntries,
  agentModeLabel,
} from './agentCommandEntries';

/**
 * 智能助手输入框的 `/` 命令面板。
 *
 * 输入以 `/` 开头时出现在输入框上方，分两组：
 * - 命令：切换 Agent 模式（进入三模式子菜单）、压缩上下文
 * - SKILL：全部已加载的 skill（选中后把技能指令插入输入框）
 *
 * 键盘交互（焦点始终在 textarea，按键由 AgentPanel 转发给本组件）：
 * - ↑ / ↓：移动高亮
 * - Enter：执行当前高亮项
 * - Backspace：模式子菜单中返回命令列表；普通面板中删除字符（面板随输入关闭）
 * - Esc：关闭面板
 * - 鼠标：hover 同步高亮，点击执行
 */

export interface AgentCommandMenuHandle {
  /** 处理输入框键盘事件；返回 true 表示已消费（调用方应 preventDefault） */
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
}

interface AgentCommandMenuProps {
  open: boolean;
  /** 输入 "/xxx" 中的 xxx（不含 "/"） */
  query: string;
  currentMode: AgentMode;
  onSelectMode: (mode: AgentMode) => void;
  /** 选中 skill：把技能指令插入输入框 */
  onInsertSkill: (prompt: string) => void;
  /** 选中「压缩上下文」 */
  onCompact: () => void;
  onClose: () => void;
}

const AgentCommandMenu = forwardRef<AgentCommandMenuHandle, AgentCommandMenuProps>(
  function AgentCommandMenu(
    { open, query, currentMode, onSelectMode, onInsertSkill, onCompact, onClose },
    ref,
  ) {
    const [activeIndex, setActiveIndex] = useState(0);
    const [modeSubmenu, setModeSubmenu] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);
    const skills = useSkillStore((s) => s.skills);
    const presence = useAnimatedPresence(open);

    const currentModeLabel = agentModeLabel(currentMode);

    const entries: MenuEntry[] = useMemo(
      () =>
        buildAgentCommandEntries({
          modeSubmenu,
          query,
          skills,
          currentModeLabel,
        }),
      [modeSubmenu, query, skills, currentModeLabel],
    );

    const selectable = useMemo(
      () => entries.filter((e) => e.kind !== 'header'),
      [entries],
    );

    // 打开 / 过滤 / 进入子菜单时重置高亮到第一项
    useEffect(() => {
      setActiveIndex(0);
    }, [open, query, modeSubmenu]);

    // 面板关闭后清除子菜单状态，下次打开回到命令列表
    useEffect(() => {
      if (!open) setModeSubmenu(false);
    }, [open]);

    // 高亮项滚动到可见区域（键盘导航时跟随）
    useEffect(() => {
      const el = listRef.current?.querySelector(`[data-active-index="${activeIndex}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    }, [activeIndex]);

    const clamp = (i: number) => {
      if (selectable.length === 0) return 0;
      return (i + selectable.length) % selectable.length;
    };

    const executeEntry = (entry: MenuEntry | null) => {
      if (!entry) return;
      if (entry.kind === 'mode') {
        onSelectMode(entry.mode.value as AgentMode);
        onClose();
        return;
      }
      if (entry.kind === 'command') {
        if (entry.id === 'toggle-mode') {
          setModeSubmenu(true);
          setActiveIndex(0);
          return;
        }
        // compact：先关面板，再由调用方触发压缩
        onClose();
        onCompact();
        return;
      }
      if (entry.kind === 'skill') {
        // 插入指令后输入不再以 "/" 开头，面板随输入自动关闭（不要清空输入）
        onInsertSkill(entry.skill.prompt);
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent): boolean => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActiveIndex((i) => clamp(i + 1));
          return true;
        case 'ArrowUp':
          e.preventDefault();
          setActiveIndex((i) => clamp(i - 1));
          return true;
        case 'Enter':
          // Shift+Enter 保留换行能力（如粘贴多行 skill 指令前想换行）
          if (e.shiftKey) return false;
          e.preventDefault();
          executeEntry(selectable[activeIndex] ?? null);
          return true;
        case 'Escape':
          e.preventDefault();
          onClose();
          return true;
        case 'Backspace':
          // 模式子菜单中优先返回命令列表；普通面板不拦截（删除字符，面板随输入关闭）
          if (modeSubmenu) {
            e.preventDefault();
            setModeSubmenu(false);
            setActiveIndex(0);
            return true;
          }
          return false;
        default:
          return false;
      }
    };

    useImperativeHandle(ref, () => ({ handleKeyDown }));

    if (!presence.mounted) return null;

    let itemIndex = -1;

    return (
      <div
        className={`absolute bottom-full left-0 mb-2 w-80 max-w-[min(24rem,calc(100vw-2rem))] z-50 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900/95 backdrop-blur-xl shadow-2xl ${
          presence.phase === 'exit' ? 'animate-slide-down-out' : 'animate-slide-up'
        }`}
        style={{ transformOrigin: 'bottom left' }}
      >
        <div ref={listRef} role="listbox" className="max-h-72 overflow-y-auto overscroll-contain py-1">
          {entries.length === 0 && (
            <div className="px-3 py-3 text-xs text-zinc-500">无匹配的指令</div>
          )}
          {entries.map((entry) => {
            if (entry.kind === 'header') {
              return (
                <div
                  key={`header-${entry.title}`}
                  className="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500"
                >
                  {entry.title}
                </div>
              );
            }
            itemIndex += 1;
            const active = itemIndex === activeIndex;
            if (entry.kind === 'mode') {
              const isCurrent = entry.mode.value === currentMode;
              return (
                <div
                  key={`mode-${entry.mode.value}`}
                  data-active-index={itemIndex}
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setActiveIndex(itemIndex)}
                  onClick={() => executeEntry(entry)}
                  className={`cursor-pointer px-3 py-2 transition-colors ${
                    active ? 'bg-indigo-600/15' : 'hover:bg-zinc-800/60'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`text-sm font-semibold ${
                        active ? 'text-indigo-200' : 'text-zinc-200'
                      }`}
                    >
                      {entry.mode.label}
                    </span>
                    {isCurrent && (
                      <span className="text-[10px] font-medium text-indigo-400">已选</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                    {entry.mode.description}
                  </div>
                </div>
              );
            }
            if (entry.kind === 'skill') {
              return (
                <div
                  key={`skill-${entry.skill.id}`}
                  data-active-index={itemIndex}
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setActiveIndex(itemIndex)}
                  onClick={() => executeEntry(entry)}
                  className={`cursor-pointer px-3 py-2 transition-colors ${
                    active ? 'bg-indigo-600/15' : 'hover:bg-zinc-800/60'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`text-sm font-medium truncate ${
                        active ? 'text-indigo-200' : 'text-zinc-200'
                      }`}
                    >
                      {entry.skill.name}
                    </span>
                    {!entry.skill.enabled && (
                      <span className="flex-shrink-0 text-[10px] text-zinc-500">未启用</span>
                    )}
                  </div>
                  {entry.skill.description && (
                    <div className="mt-0.5 truncate text-xs text-zinc-500">
                      {entry.skill.description}
                    </div>
                  )}
                </div>
              );
            }
            // command
            return (
              <div
                key={`cmd-${entry.id}`}
                data-active-index={itemIndex}
                role="option"
                aria-selected={active}
                onMouseEnter={() => setActiveIndex(itemIndex)}
                onClick={() => executeEntry(entry)}
                className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-2 transition-colors ${
                  active ? 'bg-indigo-600/15' : 'hover:bg-zinc-800/60'
                }`}
              >
                <span
                  className={`text-sm ${
                    active ? 'text-indigo-100' : 'text-zinc-200'
                  }`}
                >
                  {entry.label}
                </span>
                {entry.hint && (
                  <span className="flex-shrink-0 text-[10px] text-zinc-500">
                    {entry.hint}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  },
);

export default AgentCommandMenu;
