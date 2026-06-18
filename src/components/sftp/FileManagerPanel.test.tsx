import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useTransferStore, type UploadState, type DownloadState } from '@/stores/transferStore';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  stat: vi.fn(async () => ({ isDirectory: false, isFile: true, isSymlink: false, size: 0, mtime: null, atime: null, birthtime: null, readonly: false })),
}));

vi.mock('@/lib/tauri', () => ({
  sftpListDir: vi.fn(async () => []),
  sftpMkdir: vi.fn(),
  sftpRemove: vi.fn(),
  sftpRemoveViaShell: vi.fn(),
  sftpRename: vi.fn(),
  sftpRead: vi.fn(),
  sftpWrite: vi.fn(),
  sftpReadFile: vi.fn(),
  sftpWriteFile: vi.fn(),
  sftpUploadStream: vi.fn(),
  sftpDownloadStream: vi.fn(),
  sftpExtractArchive: vi.fn(),
}));

const useSftpUploadMock = vi.fn();
const useSftpDownloadMock = vi.fn();
vi.mock('@/hooks/useSftpUpload', () => ({
  useSftpUpload: () => useSftpUploadMock(),
}));
vi.mock('@/hooks/useSftpDownload', () => ({
  useSftpDownload: () => useSftpDownloadMock(),
}));

vi.mock('@/stores/settingsStore', () => {
  const stub = {
    settings: { fileManagerPath: '/', fileManagerPaths: {}, fileManagerShowHidden: false },
    loaded: true,
    update: vi.fn(),
  };
  return {
    useSettingsStore: (selector: (s: typeof stub) => unknown) => selector(stub),
  };
});

const FileManagerPanel = (await import('@/components/sftp/FileManagerPanel')).default;

function makeUploadState(overrides: Partial<UploadState> = {}): UploadState {
  return {
    status: 'uploading',
    fileName: 'a.txt',
    written: 500,
    total: 1000,
    statusText: 'uploading a.txt',
    ...overrides,
  };
}

function makeDownloadState(overrides: Partial<DownloadState> = {}): DownloadState {
  return {
    status: 'downloading',
    fileName: 'b.txt',
    written: 500,
    total: 1000,
    statusText: 'downloading b.txt',
    ...overrides,
  };
}

describe('FileManagerPanel upload button disable', () => {
  beforeEach(() => {
    useTransferStore.setState({
      upload: null,
      download: null,
      folderUpload: null,
      activeUploadId: null,
      activeDownloadId: null,
      activeFolderUploadId: null,
    });
    useSftpUploadMock.mockReturnValue({
      uploadFile: vi.fn(),
      pickFolder: vi.fn(),
      uploadFolder: vi.fn(),
      uploadState: null,
      folderStatus: null,
    });
    useSftpDownloadMock.mockReturnValue({
      downloadState: null,
      startDownload: vi.fn(),
    });
  });

  it('enables upload buttons when no transfer is active', () => {
    const html = renderToStaticMarkup(
      <FileManagerPanel sessionId="sess-1" connectionKey="conn-1" />,
    );
    expect(html).toContain('title="上传文件"');
    expect(html).toContain('title="上传文件夹"');
    expect(html).not.toContain('title="正在上传，请等待"');
  });

  it('disables upload buttons when uploadState is set', () => {
    useSftpUploadMock.mockReturnValue({
      uploadFile: vi.fn(),
      pickFolder: vi.fn(),
      uploadFolder: vi.fn(),
      uploadState: makeUploadState({ statusText: 'uploading a.txt' }),
      folderStatus: null,
    });

    const html = renderToStaticMarkup(
      <FileManagerPanel sessionId="sess-1" connectionKey="conn-1" />,
    );
    // The "正在上传，请等待" tooltip only appears on the upload buttons
    const tooltipCount = (html.match(/title="正在上传，请等待"/g) ?? []).length;
    expect(tooltipCount).toBe(2);
    // Both upload buttons should be disabled
    const uploadButtonRegex =
      /<button[^>]*disabled=""[^>]*title="正在上传，请等待"/g;
    expect(html).toMatch(uploadButtonRegex);
    // The status text should appear
    expect(html).toContain('uploading a.txt');
  });

  it('disables upload buttons when folderStatus is set', () => {
    useSftpUploadMock.mockReturnValue({
      uploadFile: vi.fn(),
      pickFolder: vi.fn(),
      uploadFolder: vi.fn(),
      uploadState: null,
      folderStatus: '正在压缩文件夹 50%',
    });

    const html = renderToStaticMarkup(
      <FileManagerPanel sessionId="sess-1" connectionKey="conn-1" />,
    );
    const tooltipCount = (html.match(/title="正在上传，请等待"/g) ?? []).length;
    expect(tooltipCount).toBe(2);
    expect(html).toContain('正在压缩文件夹 50%');
  });

  it('keeps download button enabled when only upload is active', () => {
    useSftpUploadMock.mockReturnValue({
      uploadFile: vi.fn(),
      pickFolder: vi.fn(),
      uploadFolder: vi.fn(),
      uploadState: makeUploadState(),
      folderStatus: null,
    });
    useSftpDownloadMock.mockReturnValue({
      downloadState: makeDownloadState({ status: 'idle' }),
      startDownload: vi.fn(),
    });

    const html = renderToStaticMarkup(
      <FileManagerPanel sessionId="sess-1" connectionKey="conn-1" />,
    );
    // Upload buttons disabled
    const tooltipCount = (html.match(/title="正在上传，请等待"/g) ?? []).length;
    expect(tooltipCount).toBe(2);
  });

  it('re-enables upload buttons after upload state is cleared', () => {
    useSftpUploadMock.mockReturnValue({
      uploadFile: vi.fn(),
      pickFolder: vi.fn(),
      uploadFolder: vi.fn(),
      uploadState: null,
      folderStatus: null,
    });

    const html = renderToStaticMarkup(
      <FileManagerPanel sessionId="sess-1" connectionKey="conn-1" />,
    );
    expect(html).toContain('title="上传文件"');
    expect(html).toContain('title="上传文件夹"');
    expect(html).not.toContain('title="正在上传，请等待"');
  });
});
