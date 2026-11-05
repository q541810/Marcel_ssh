import { create } from 'zustand';
import type { OpenIntent } from '@/lib/sftpFileOpen';
import type { MobileTabId } from '@/mobile/tabs';

/**
 * 「带我去那个文件」的待办信箱 + 一条轻提示。
 *
 * 文件管理器（桌面底栏 / 手机文件页）可能当下根本没挂载——底栏收着时面板是卸载的，手机
 * 文件页要先切过去——所以 `fileNav` 不直接操作面板，而是把请求放进这里，由面板挂载（或
 * 已挂载时订阅到）后自己领走。按会话分桶：同一会话后来的请求覆盖前一个。
 * 请求有保质期：用户很久之后才打开面板，不该突然弹出一个陈年编辑器。
 */

export type FileNavIntent = 'reveal' | OpenIntent;

export interface FileNavRequest {
  seq: number;
  sessionId: string;
  /** 目标的绝对路径（目录或文件）。 */
  path: string;
  isDir: boolean;
  /** stat 得到的大小；不知道时为 0。 */
  size: number;
  intent: FileNavIntent;
  /**
   * 手机：请求发出时用户在哪个页签（agent 对话等）。文件页据此在编辑器 / 预览关闭或点「返回」时
   * 把用户送回原处。桌面端对话与文件管理并排可见，不需要，恒为 null。
   */
  returnTo?: MobileTabId | null;
  requestedAt: number;
}

export interface FileNavNotice {
  seq: number;
  text: string;
  tone: 'error' | 'info';
}

export const FILE_NAV_TTL_MS = 15_000;

interface FileNavState {
  pending: Record<string, FileNavRequest | undefined>;
  notice: FileNavNotice | null;
  /** 各会话文件管理器正在看的目录（面板发布，「相对文件管理当前目录」读它）。 */
  viewingDir: Record<string, string | undefined>;
  setViewingDir: (sessionId: string, dir: string) => void;
  push: (req: Omit<FileNavRequest, 'seq' | 'requestedAt'>) => void;
  /** 领走这个会话的待办（过期的直接丢弃，返回 null）。 */
  take: (sessionId: string) => FileNavRequest | null;
  notify: (text: string, tone?: FileNavNotice['tone']) => void;
  clearNotice: (seq?: number) => void;
}

let seqCounter = 0;

export const useFileNavStore = create<FileNavState>((set, get) => ({
  pending: {},
  notice: null,
  viewingDir: {},
  setViewingDir: (sessionId, dir) =>
    set((s) => (s.viewingDir[sessionId] === dir ? s : { viewingDir: { ...s.viewingDir, [sessionId]: dir } })),
  push: (req) =>
    set((s) => ({
      pending: { ...s.pending, [req.sessionId]: { ...req, seq: ++seqCounter, requestedAt: Date.now() } },
    })),
  take: (sessionId) => {
    const req = get().pending[sessionId];
    if (!req) return null;
    set((s) => {
      const next = { ...s.pending };
      delete next[sessionId];
      return { pending: next };
    });
    return Date.now() - req.requestedAt > FILE_NAV_TTL_MS ? null : req;
  },
  notify: (text, tone = 'error') => set({ notice: { seq: ++seqCounter, text, tone } }),
  clearNotice: (seq) =>
    set((s) => (seq === undefined || s.notice?.seq === seq ? { notice: null } : s)),
}));
