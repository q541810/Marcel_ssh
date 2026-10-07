/** A shared reveal boundary makes a virtualized group behave like one accordion. */
export function groupRevealFrames(offset: number, height: number, from: number, to: number): Keyframe[] {
  const distance = to - from;
  const progress = distance !== 0
    ? [0, (offset - from) / distance, (offset + height - from) / distance, 1]
    : [0, 1];
  return [...new Set(progress.filter((value) => value >= 0 && value <= 1))].sort((a, b) => a - b)
    .map((value) => ({ offset: value, height: `${Math.max(0, Math.min(height, from + distance * value - offset))}px` }));
}

type Member = { node: HTMLElement; inner: HTMLElement; done: () => void; height: number; oldHeight: string; oldOverflow: string; animation?: Animation };
type Batch = { members: Map<string, Member>; animations: Animation[]; frame: number | null; timer: ReturnType<typeof setTimeout> | null; observer: ResizeObserver | null };

export class ToolGroupReveal {
  private batches = new Map<string, Batch>();

  register(group: string, key: string, node: HTMLElement, inner: HTMLElement, done: () => void, initialHeight = 0, closing = false) {
    let batch = this.batches.get(group);
    if (!batch) {
      batch = { members: new Map(), animations: [], frame: null, timer: null, observer: null };
      this.batches.set(group, batch);
    }
    const member: Member = { node, inner, done, height: inner.getBoundingClientRect().height,
      oldHeight: node.style.height, oldOverflow: node.style.overflow };
    node.style.height = `${initialHeight}px`;
    node.style.overflow = 'hidden';
    batch.members.set(key, member);
    if (typeof ResizeObserver !== 'undefined') {
      batch.observer ??= new ResizeObserver(() => {
        if ([...batch!.members.values()].some((entry) => Math.abs(entry.inner.getBoundingClientRect().height - entry.height) > 0.5)) {
          this.schedule(group, batch!, closing);
        }
      });
      batch.observer.observe(inner);
    }
    this.schedule(group, batch, closing);
    return () => {
      if (batch!.members.get(key) !== member) return;
      batch!.members.delete(key);
      batch!.observer?.unobserve(inner);
      if (member.animation) { member.animation.onfinish = null; member.animation.cancel(); }
      node.style.height = member.oldHeight;
      node.style.overflow = member.oldOverflow;
      if (!batch!.members.size) this.clear(group, batch!);
      else this.schedule(group, batch!, closing);
    };
  }

  private schedule(group: string, batch: Batch, closing = false) {
    if (batch.frame !== null) return;
    batch.frame = requestAnimationFrame(() => { batch.frame = null; this.start(group, batch, closing); });
  }

  private start(group: string, batch: Batch, closing: boolean) {
    if (this.batches.get(group) !== batch || !batch.members.size) return;
    const members = [...batch.members.values()].sort((a, b) =>
      a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    // Freeze the current aperture before cancelling an interrupted animation.
    const from = members.reduce((sum, member) => sum + member.node.getBoundingClientRect().height, 0);
    for (const member of members) member.node.style.height = `${member.node.getBoundingClientRect().height}px`;
    for (const animation of batch.animations) { animation.onfinish = null; animation.cancel(); }
    batch.animations = [];
    if (batch.timer !== null) clearTimeout(batch.timer);
    for (const member of members) member.height = member.inner.getBoundingClientRect().height;
    const total = members.reduce((sum, member) => sum + member.height, 0);
    let offset = 0;
    let remaining = members.length;
    const startTime = document.timeline?.currentTime;
    const finish = () => {
      if (this.batches.get(group) !== batch || batch.frame !== null) return;
      if (members.some((member) => Math.abs(member.inner.getBoundingClientRect().height - member.height) > 0.5)) {
        this.schedule(group, batch, closing);
        return;
      }
      this.clear(group, batch);
      // Keep the completed collapse at zero until React removes the retained rows.
      if (closing) members.forEach((member) => { member.node.style.height = '0px'; member.node.style.overflow = 'hidden'; });
      members.forEach((member) => member.done());
    };
    for (const member of members) {
      const animation = member.node.animate(groupRevealFrames(offset, member.height, from, closing ? 0 : total), {
        duration: 280, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both',
      });
      if (typeof startTime === 'number') animation.startTime = startTime;
      member.animation = animation;
      animation.onfinish = () => { if (--remaining === 0) finish(); };
      batch.animations.push(animation);
      offset += member.height;
    }
    batch.timer = setTimeout(finish, 1500);
  }

  private clear(group: string, batch: Batch) {
    if (batch.frame !== null) cancelAnimationFrame(batch.frame);
    if (batch.timer !== null) clearTimeout(batch.timer);
    batch.observer?.disconnect();
    for (const animation of batch.animations) { animation.onfinish = null; animation.cancel(); }
    for (const member of batch.members.values()) {
      member.node.style.height = member.oldHeight;
      member.node.style.overflow = member.oldOverflow;
    }
    batch.members.clear();
    this.batches.delete(group);
  }

  dispose() {
    for (const [group, batch] of this.batches) this.clear(group, batch);
  }
}
