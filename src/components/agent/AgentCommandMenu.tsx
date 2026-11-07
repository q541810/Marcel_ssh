import { Check } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { AgentMode, Skill } from '@/lib/types';
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
 * - SKILL：全部已加载的 skill（选中后在输入框上方加一个标签，可连续引用多个）
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
  /** 选中 skill：加成输入框上方的标签（宿主负责清掉 `/xxx`） */
  onPickSkill: (skill: Skill) => void;
  /** 已加成标签的 skill id；不再出现在列表里 */
  selectedSkillIds?: readonly string[];
  /** 选中「压缩上下文」 */
  onCompact: () => void;
  /** 选中「分叉会话」：把当前会话整份复制成新会话并切过去 */
  onFork: () => void;
  onClose: () => void;
}

const AgentCommandMenu = forwardRef<AgentCommandMenuHandle, AgentCommandMenuProps>(
  function AgentCommandMenu(
    { open, query, currentMode, onSelectMode, onPickSkill, selectedSkillIds, onCompact, onFork, onClose },
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
          excludeSkillIds: selectedSkillIds,
        }),
      [modeSubmenu, query, skills, currentModeLabel, selectedSkillIds],
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
        // compact / fork：先关面板（清掉 "/xxx"），再由调用方触发
        onClose();
        if (entry.id === 'fork') onFork();
        else onCompact();
        return;
      }
      if (entry.kind === 'skill') {
        // 宿主加标签并清掉 "/xxx"，面板随输入自动关闭；想再加一个就再输 "/"
        onPickSkill(entry.skill);
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
          // Shift+Enter 保留换行能力
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
        className={`absolute bottom-full left-0 mb-2 w-80 max-w-[min(24rem,calc(100vw-2rem))] z-50 overflow-hidden origin-bottom-left rounded-xl surface-glass ${
          presence.phase === 'exit' ? 'animate-slide-down-out' : 'animate-slide-up'
        }`}
        style={{ transformOrigin: 'bottom left' }}
      >
        <div ref={listRef} role="listbox" className="max-h-72 overflow-y-auto overscroll-contain p-1">
          {entries.length === 0 && (
            <div className="px-3 py-3 text-meta text-fg-tertiary">无匹配的指令</div>
          )}
          {entries.map((entry) => {
            if (entry.kind === 'header') {
              return (
                <div
                  key={`header-${entry.title}`}
                  className="px-3 pt-2.5 pb-1 text-caption font-semibold uppercase tracking-wider text-fg-tertiary"
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
                  className={`cursor-pointer rounded-lg px-3 py-2 transition-colors duration-120 ${
                    active ? 'bg-fill' : ''
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className="text-read font-semibold text-fg"
                    >
                      {entry.mode.label}
                    </span>
                    {isCurrent && (
                      <Check size={14} strokeWidth={2} className="flex-shrink-0 text-indigo-400" aria-label="当前模式" />
                    )}
                  </div>
                  <div className="mt-0.5 text-meta leading-relaxed text-fg-tertiary">
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
                  className={`cursor-pointer rounded-lg px-3 py-2 transition-colors duration-120 ${
                    active ? 'bg-fill' : ''
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className="text-read font-medium truncate text-fg"
                    >
                      {entry.skill.name}
                    </span>
                    {!entry.skill.enabled && (
                      <span className="flex-shrink-0 text-caption text-fg-tertiary">未启用</span>
                    )}
                  </div>
                  {entry.skill.description && (
                    <div className="mt-0.5 truncate text-meta text-fg-tertiary">
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
                className={`flex cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 transition-colors duration-120 ${
                  active ? 'bg-fill' : ''
                }`}
              >
                <span
                  className="text-read text-fg"
                >
                  {entry.label}
                </span>
                {entry.hint && (
                  <span className="flex-shrink-0 text-caption text-fg-tertiary">
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
