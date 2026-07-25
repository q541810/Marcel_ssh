import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useTransferStore } from '@/stores/transferStore';

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
  sftpCancelDownload: vi.fn(),
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
    settings: {
      fileManagerPath: '/',
      fileManagerPaths: {},
      fileManagerShowHidden: false,
      fileManagerTreeWidth: 200,
      fileManagerTreeUserHidden: false,
    },
    loaded: true,
    update: vi.fn(),
  };
  return {
    useSettingsStore: (selector: (s: typeof stub) => unknown) => selector(stub),
  };
});

const FileManagerPanel = (await import('@/components/sftp/FileManagerPanel')).default;

describe('FileManagerPanel after transfer center migration', () => {
  beforeEach(() => {
    useTransferStore.setState({ items: {}, order: [] });
    useSftpUploadMock.mockReturnValue({
      uploadFile: vi.fn(),
      pickFolder: vi.fn(),
      uploadFolder: vi.fn(),
    });
    useSftpDownloadMock.mockReturnValue({
      startDownload: vi.fn(),
    });
  });

  it('renders upload buttons enabled with plain tooltips', () => {
    const html = renderToStaticMarkup(
      <FileManagerPanel sessionId="sess-1" connectionKey="conn-1" />,
    );
    expect(html).toContain('title="上传文件"');
    expect(html).toContain('title="上传文件夹"');
    expect(html).not.toContain('title="正在上传，请等待"');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*title="上传文件"/);
  });

  it('shows no inline transfer banners even with active transfers in the store', () => {
    useTransferStore.getState().addItem({
      id: 'u1',
      kind: 'upload',
      sessionId: 'sess-1',
      fileName: 'a.txt',
      localPath: 'C:/tmp/a.txt',
      remotePath: '/a.txt',
      written: 500,
      total: 1000,
      statusText: '上传 500 B / 1000 B (50%)',
      createdAt: 1,
    });
    useTransferStore.getState().updateItem('u1', { status: 'active' });

    const html = renderToStaticMarkup(
      <FileManagerPanel sessionId="sess-1" connectionKey="conn-1" />,
    );
    expect(html).not.toContain('上传 500 B / 1000 B');
    expect(html).not.toContain('title="取消上传"');
    expect(html).not.toContain('title="取消下载"');
  });
});
