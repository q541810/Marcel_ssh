import { create } from 'zustand';

let uploadTimerId: ReturnType<typeof setTimeout> | null = null;
let downloadTimerId: ReturnType<typeof setTimeout> | null = null;

export interface UploadState {
  status: 'uploading' | 'done' | 'error' | 'cancelled';
  fileName: string;
  written: number;
  total: number;
  statusText: string;
}

export interface DownloadState {
  status: 'idle' | 'downloading' | 'done' | 'error';
  fileName: string;
  written: number;
  total: number;
  statusText: string;
}

interface TransferState {
  upload: UploadState | null;
  download: DownloadState | null;
  folderUpload: string | null;

  activeUploadId: string | null;
  activeDownloadId: string | null;
  activeFolderUploadId: string | null;

  setUpload: (state: UploadState | null) => void;
  setDownload: (state: DownloadState | null) => void;
  setFolderUpload: (status: string | null) => void;
  setActiveUploadId: (id: string | null) => void;
  setActiveDownloadId: (id: string | null) => void;
  setActiveFolderUploadId: (id: string | null) => void;
  clearUploadAfter: (ms: number) => void;
  clearDownloadAfter: (ms: number) => void;
}

export const useTransferStore = create<TransferState>((set) => ({
  upload: null,
  download: null,
  folderUpload: null,

  activeUploadId: null,
  activeDownloadId: null,
  activeFolderUploadId: null,

  setUpload: (state) => {
    if (uploadTimerId !== null) {
      clearTimeout(uploadTimerId);
      uploadTimerId = null;
    }
    set({ upload: state });
  },
  setDownload: (state) => {
    if (downloadTimerId !== null) {
      clearTimeout(downloadTimerId);
      downloadTimerId = null;
    }
    set({ download: state });
  },
  setFolderUpload: (status) => set({ folderUpload: status }),
  setActiveUploadId: (id) => set({ activeUploadId: id }),
  setActiveDownloadId: (id) => set({ activeDownloadId: id }),
  setActiveFolderUploadId: (id) => set({ activeFolderUploadId: id }),

  clearUploadAfter: (ms) => {
    if (uploadTimerId !== null) {
      clearTimeout(uploadTimerId);
    }
    uploadTimerId = setTimeout(() => {
      uploadTimerId = null;
      set({ upload: null });
    }, ms);
  },
  clearDownloadAfter: (ms) => {
    if (downloadTimerId !== null) {
      clearTimeout(downloadTimerId);
    }
    downloadTimerId = setTimeout(() => {
      downloadTimerId = null;
      set({ download: null });
    }, ms);
  },
}));
