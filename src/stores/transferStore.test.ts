import { describe, it, expect, beforeEach } from 'vitest';
import { useTransferStore } from '@/stores/transferStore';

describe('transferStore', () => {
  beforeEach(() => {
    useTransferStore.setState({
      upload: null,
      download: null,
      folderUpload: null,
      activeUploadId: null,
      activeDownloadId: null,
      activeFolderUploadId: null,
    });
  });

  it('starts with null states', () => {
    const state = useTransferStore.getState();
    expect(state.upload).toBeNull();
    expect(state.download).toBeNull();
    expect(state.folderUpload).toBeNull();
    expect(state.activeUploadId).toBeNull();
  });

  it('sets upload state', () => {
    useTransferStore.getState().setUpload({
      status: 'uploading',
      fileName: 'a.txt',
      written: 100,
      total: 1000,
      statusText: 'uploading',
    });
    expect(useTransferStore.getState().upload?.fileName).toBe('a.txt');
  });

  it('sets activeUploadId and clears on next set', () => {
    useTransferStore.getState().setActiveUploadId('123');
    expect(useTransferStore.getState().activeUploadId).toBe('123');
    useTransferStore.getState().setActiveUploadId(null);
    expect(useTransferStore.getState().activeUploadId).toBeNull();
  });

  it('clearUploadAfter sets a timer that nullifies upload', async () => {
    useTransferStore.getState().setUpload({
      status: 'done',
      fileName: 'a.txt',
      written: 0,
      total: 0,
      statusText: 'done',
    });
    useTransferStore.getState().clearUploadAfter(50);
    expect(useTransferStore.getState().upload).not.toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(useTransferStore.getState().upload).toBeNull();
  });

  it('clearDownloadAfter sets a timer that nullifies download', async () => {
    useTransferStore.getState().setDownload({
      status: 'done',
      fileName: 'b.txt',
      written: 0,
      total: 0,
      statusText: 'done',
    });
    useTransferStore.getState().clearDownloadAfter(50);
    expect(useTransferStore.getState().download).not.toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(useTransferStore.getState().download).toBeNull();
  });

  it('sets folder upload status', () => {
    useTransferStore.getState().setFolderUpload('uploading...');
    expect(useTransferStore.getState().folderUpload).toBe('uploading...');
    useTransferStore.getState().setFolderUpload(null);
    expect(useTransferStore.getState().folderUpload).toBeNull();
  });

  it('isUploading derives from upload and folderUpload being non-null', () => {
    const isUploading = (s: ReturnType<typeof useTransferStore.getState>) =>
      s.upload !== null || s.folderUpload !== null;
    expect(isUploading(useTransferStore.getState())).toBe(false);
    useTransferStore.getState().setUpload({
      status: 'uploading',
      fileName: 'a',
      written: 0,
      total: 0,
      statusText: '',
    });
    expect(isUploading(useTransferStore.getState())).toBe(true);
    useTransferStore.getState().setUpload(null);
    expect(isUploading(useTransferStore.getState())).toBe(false);
    useTransferStore.getState().setFolderUpload('zipping');
    expect(isUploading(useTransferStore.getState())).toBe(true);
  });
});
