import { useState, useMemo, useRef, useEffect, type ReactNode } from 'react';
import HelpModal from '../HelpModal';
import WinIcon from '@/components/ui/WinIcon';
import TransferQueue from '../sftp/TransferQueue';
import { useViewStore, byNavGroup } from '@/stores/viewStore';
import { useTransferStore, selectBadgeCount } from '@/stores/transferStore';
import { registerTransferTarget } from '@/stores/transferFlyAnimation';
import type { ViewIcon } from '@/lib/types';

interface Props {
  activeId: string;
  onChange: (id: string) => void;
}

function renderIcon(icon: ViewIcon): ReactNode {
  if (icon.kind === 'react') return icon.node;
  if (icon.kind === 'svg') {
    return <img src={icon.path} alt="" className="w-5 h-5" />;
  }
  if (icon.kind === 'img') {
    return <img src={icon.src} alt="" className="w-5 h-5" />;
  }
  return null;
}

function NavButton({
  title,
  icon,
  active,
  onClick,
  badge,
  buttonRef,
}: {
  title: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
  badge?: number;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`win-nav-item ${active ? 'active' : ''}`}
    >
      {active && <span className="win-nav-pill" />}
      <span className="relative z-[1] flex items-center justify-center">{icon}</span>
      {badge !== undefined && badge > 0 && (
        <span className="absolute top-0.5 right-0.5 min-w-4 h-4 px-1 rounded-full bg-indigo-500 text-[10px] leading-4 text-white text-center z-[2]">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}

export default function NavRail({ activeId, onChange }: Props) {
  const [helpOpen, setHelpOpen] = useState(false);
  const providers = useViewStore((s) => s.providers);
  const topItems = useMemo(() => byNavGroup(providers, 'top'), [providers]);
  const bottomItems = useMemo(() => byNavGroup(providers, 'bottom'), [providers]);
  const transferBadge = useTransferStore(selectBadgeCount);
  const transferOpen = useTransferStore((s) => s.open);
  const setTransferOpen = useTransferStore((s) => s.setOpen);
  const transferBtnRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const [indicatorY, setIndicatorY] = useState<number | null>(null);

  // 计算激活项在导航栏内的纵向位置，驱动共享小蓝条滑动
  useEffect(() => {
    const updateIndicator = () => {
      const nav = navRef.current;
      if (!nav) return;
      const active = nav.querySelector<HTMLElement>('.win-nav-item.active');
      if (!active) {
        setIndicatorY((prev) => (prev === null ? null : prev));
        return;
      }
      const navRect = nav.getBoundingClientRect();
      const btnRect = active.getBoundingClientRect();
      setIndicatorY(btnRect.top - navRect.top + (btnRect.height - 20) / 2);
    };
    updateIndicator();
    const raf = requestAnimationFrame(updateIndicator);
    window.addEventListener('resize', updateIndicator);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', updateIndicator);
    };
  }, [activeId, transferOpen, providers]);

  useEffect(() => {
    registerTransferTarget(transferBtnRef.current);
    return () => registerTransferTarget(null);
  }, []);

  return (
    <nav
      ref={navRef}
      className="relative flex flex-col items-center justify-between w-14 flex-shrink-0 win-acrylic border-r border-zinc-800 py-2"
    >
      <span
        className={`win-nav-indicator ${indicatorY !== null ? 'visible' : ''}`}
        style={indicatorY !== null ? { ['--indicator-y' as string]: `${indicatorY}px` } : undefined}
      />
      <div className="flex flex-col gap-1">
        {topItems.map((p) => (
          <NavButton
            key={p.id}
            title={p.title}
            icon={renderIcon(p.icon)}
            active={activeId === p.id}
            onClick={() => onChange(p.id)}
          />
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <NavButton
          title="帮助"
          icon={<WinIcon glyph="help" size={20} />}
          active={false}
          onClick={() => setHelpOpen(true)}
        />
        <NavButton
          title="同步中心"
          icon={<WinIcon glyph="sync" size={20} />}
          active={transferOpen}
          onClick={() => setTransferOpen(!transferOpen)}
          badge={transferBadge}
          buttonRef={transferBtnRef}
        />
        {bottomItems.map((p) => (
          <NavButton
            key={p.id}
            title={p.title}
            icon={renderIcon(p.icon)}
            active={activeId === p.id}
            onClick={() => onChange(p.id)}
          />
        ))}
      </div>
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
      <TransferQueue open={transferOpen} onClose={() => setTransferOpen(false)} />
    </nav>
  );
}
