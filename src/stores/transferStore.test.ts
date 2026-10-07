import { describe, it, expect, beforeEach } from 'vitest';
import {
  useTransferStore,
  selectByLane,
  selectActiveOf,
  selectQueuedOf,
  selectBadgeCount,
  selectUnreadErrorCount,
  laneOf,
  type TransferItem,
} from '@/stores/transferStore';

let seq = 0;
function makeItem(patch: Partial<TransferItem> = {}): TransferItem {
  seq += 1;
  return {
    id: `t-${seq}`,
    kind: 'upload',
    sessionId: 's1',
    fileName: `file-${seq}.txt`,
    localPath: `C:/tmp/file-${seq}.txt`,
    remotePath: `/srv/file-${seq}.txt`,
    written: 0,
    total: 100,
    statusText: '排队中',
    createdAt: seq,
    ...patch,
  };
}

describe('transferStore', () => {
  beforeEach(() => {
    useTransferStore.setState({ items: {}, order: [], open: false, unreadErrorIds: [] });
  });

  it('addItem inserts with queued status and preserves order', () => {
    const a = makeItem();
    const b = makeItem({ kind: 'download' });
    useTransferStore.getState().addItem(a);
    useTransferStore.getState().addItem(b);
    const state = useTransferStore.getState();
    expect(state.order).toEqual([a.id, b.id]);
    expect(state.items[a.id].status).toBe('queued');
    expect(state.items[b.id].status).toBe('queued');
  });

  it('addItem ignores duplicate ids', () => {
    const a = makeItem();
    useTransferStore.getState().addItem(a);
    useTransferStore.getState().updateItem(a.id, { status: 'active' });
    useTransferStore.getState().addItem(a);
    const state = useTransferStore.getState();
    expect(state.order).toEqual([a.id]);
    expect(state.items[a.id].status).toBe('active');
  });

  it('updateItem patches fields and no-ops on unknown id', () => {
    const a = makeItem();
    useTransferStore.getState().addItem(a);
    useTransferStore.getState().updateItem(a.id, { written: 50, statusText: '50%' });
    expect(useTransferStore.getState().items[a.id].written).toBe(50);
    useTransferStore.getState().updateItem('missing', { written: 1 });
    expect(useTransferStore.getState().items['missing']).toBeUndefined();
  });

  it('updateItem refuses finished → in-progress regression', () => {
    const a = makeItem();
    useTransferStore.getState().addItem(a);
    useTransferStore.getState().updateItem(a.id, { status: 'done' });
    useTransferStore.getState().updateItem(a.id, { status: 'active' });
    expect(useTransferStore.getState().items[a.id].status).toBe('done');
  });

  it('removeItem deletes item and order entry', () => {
    const a = makeItem();
    const b = makeItem();
    useTransferStore.getState().addItem(a);
    useTransferStore.getState().addItem(b);
    useTransferStore.getState().removeItem(a.id);
    const state = useTransferStore.getState();
    expect(state.order).toEqual([b.id]);
    expect(state.items[a.id]).toBeUndefined();
  });

  it('clearFinished removes only done/error/cancelled', () => {
    const a = makeItem();
    const b = makeItem();
    const c = makeItem();
    const d = makeItem();
    for (const it of [a, b, c, d]) useTransferStore.getState().addItem(it);
    useTransferStore.getState().updateItem(a.id, { status: 'done' });
    useTransferStore.getState().updateItem(b.id, { status: 'error' });
    useTransferStore.getState().updateItem(c.id, { status: 'active' });
    useTransferStore.getState().clearFinished();
    expect(useTransferStore.getState().order).toEqual([c.id, d.id]);
  });

  it('laneOf maps folder-upload to upload lane', () => {
    expect(laneOf('upload')).toBe('upload');
    expect(laneOf('folder-upload')).toBe('upload');
    expect(laneOf('download')).toBe('download');
  });

  it('lane selectors split items and find active/queued', () => {
    const up = makeItem();
    const folder = makeItem({ kind: 'folder-upload' });
    const down = makeItem({ kind: 'download' });
    for (const it of [up, folder, down]) useTransferStore.getState().addItem(it);
    useTransferStore.getState().updateItem(up.id, { status: 'active' });

    const state = useTransferStore.getState();
    expect(selectByLane(state, 'upload').map((i) => i.id)).toEqual([up.id, folder.id]);
    expect(selectByLane(state, 'download').map((i) => i.id)).toEqual([down.id]);
    expect(selectActiveOf(state, 'upload')?.id).toBe(up.id);
    expect(selectActiveOf(state, 'download')).toBeNull();
    expect(selectQueuedOf(state, 'upload').map((i) => i.id)).toEqual([folder.id]);
  });

  it('selectActiveOf treats cancelling as occupying the lane', () => {
    const a = makeItem();
    useTransferStore.getState().addItem(a);
    useTransferStore.getState().updateItem(a.id, { status: 'cancelling' });
    expect(selectActiveOf(useTransferStore.getState(), 'upload')?.id).toBe(a.id);
  });

  it('selectBadgeCount counts unfinished items only', () => {
    const a = makeItem();
    const b = makeItem();
    const c = makeItem();
    for (const it of [a, b, c]) useTransferStore.getState().addItem(it);
    useTransferStore.getState().updateItem(a.id, { status: 'active' });
    useTransferStore.getState().updateItem(b.id, { status: 'done' });
    expect(selectBadgeCount(useTransferStore.getState())).toBe(2);
  });

  it('error transition while panel closed records unread error', () => {
    const a = makeItem();
    useTransferStore.getState().addItem(a);
    useTransferStore.getState().updateItem(a.id, { status: 'error' });
    const state = useTransferStore.getState();
    expect(state.unreadErrorIds).toEqual([a.id]);
    expect(selectUnreadErrorCount(state)).toBe(1);
  });

  it('repeated error patches do not duplicate unread entries', () => {
    const a = makeItem();
    useTransferStore.getState().addItem(a);
    useTransferStore.getState().updateItem(a.id, { status: 'error' });
    useTransferStore.getState().updateItem(a.id, { statusText: '下载失败：again' });
    expect(useTransferStore.getState().unreadErrorIds).toEqual([a.id]);
  });

  it('non-error transitions never record unread', () => {
    const a = makeItem();
    const b = makeItem();
    useTransferStore.getState().addItem(a);
    useTransferStore.getState().addItem(b);
    useTransferStore.getState().updateItem(a.id, { status: 'done' });
    useTransferStore.getState().updateItem(b.id, { status: 'cancelled' });
    expect(useTransferStore.getState().unreadErrorIds).toEqual([]);
  });

  it('errors while panel open are not recorded', () => {
    const a = makeItem();
    useTransferStore.getState().addItem(a);
    useTransferStore.getState().setOpen(true);
    useTransferStore.getState().updateItem(a.id, { status: 'error' });
    expect(useTransferStore.getState().unreadErrorIds).toEqual([]);
  });

  it('setOpen(true) clears unread errors', () => {
    const a = makeItem();
    const b = makeItem();
    for (const it of [a, b]) useTransferStore.getState().addItem(it);
    useTransferStore.getState().updateItem(a.id, { status: 'error' });
    useTransferStore.getState().updateItem(b.id, { status: 'error' });
    useTransferStore.getState().setOpen(true);
    expect(useTransferStore.getState().unreadErrorIds).toEqual([]);
  });

  it('errors after closing the panel accumulate again', () => {
    const a = makeItem();
    const b = makeItem();
    for (const it of [a, b]) useTransferStore.getState().addItem(it);
    useTransferStore.getState().updateItem(a.id, { status: 'error' });
    useTransferStore.getState().setOpen(true);
    useTransferStore.getState().setOpen(false);
    useTransferStore.getState().updateItem(b.id, { status: 'error' });
    const state = useTransferStore.getState();
    expect(state.unreadErrorIds).toEqual([b.id]);
    expect(selectUnreadErrorCount(state)).toBe(1);
  });

  it('removeItem prunes unread errors (no ghost count)', () => {
    const a = makeItem();
    useTransferStore.getState().addItem(a);
    useTransferStore.getState().updateItem(a.id, { status: 'error' });
    useTransferStore.getState().removeItem(a.id);
    expect(useTransferStore.getState().unreadErrorIds).toEqual([]);
  });

  it('clearFinished prunes unread errors of removed items', () => {
    const a = makeItem();
    const b = makeItem();
    for (const it of [a, b]) useTransferStore.getState().addItem(it);
    useTransferStore.getState().updateItem(a.id, { status: 'error' });
    useTransferStore.getState().clearFinished();
    expect(useTransferStore.getState().unreadErrorIds).toEqual([]);
    expect(useTransferStore.getState().order).toEqual([b.id]);
  });

  it('finished-item overflow trim prunes unread errors of dropped items', () => {
    const batch = Array.from({ length: 51 }, () => makeItem());
    for (const it of batch) useTransferStore.getState().addItem(it);
    for (const it of batch) useTransferStore.getState().updateItem(it.id, { status: 'error' });
    expect(useTransferStore.getState().unreadErrorIds.length).toBe(51);
    // 再入队 1 条触发完成项裁剪：最旧的失败项被裁掉，其未读记录同步修剪
    useTransferStore.getState().addItem(makeItem());
    const state = useTransferStore.getState();
    expect(state.items[batch[0].id]).toBeUndefined();
    expect(state.unreadErrorIds).not.toContain(batch[0].id);
    expect(state.unreadErrorIds.length).toBe(50);
  });
});
