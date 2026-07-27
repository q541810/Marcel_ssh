import { useState, useMemo, useRef, useEffect, type ReactNode } from 'react';
import { HelpCircle, ArrowUpDown } from 'lucide-react';
import HelpModal from '../HelpModal';
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
      className={`
        relative flex items-center justify-center w-12 h-12 rounded-lg transition-colors
        ${
          active
            ? 'bg-zinc-800 text-indigo-400'
            : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60'
        }
      `}
    >
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 rounded-r bg-indigo-400" />
      )}
      {icon}
      {badge !== undefined && badge > 0 && (
        <span className="absolute top-1 right-1 min-w-4 h-4 px-1 rounded-full bg-indigo-500 text-[10px] leading-4 text-white text-center">
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

  useEffect(() => {
    registerTransferTarget(transferBtnRef.current);
    return () => registerTransferTarget(null);
  }, []);

  return (
    <nav className="flex flex-col items-center justify-between w-14 flex-shrink-0 bg-zinc-950 border-r border-zinc-800 py-2">
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
          icon={<HelpCircle className="w-5 h-5" />}
          active={false}
          onClick={() => setHelpOpen(true)}
        />
        <NavButton
          title="传输中心"
          icon={<ArrowUpDown className="w-5 h-5" />}
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
