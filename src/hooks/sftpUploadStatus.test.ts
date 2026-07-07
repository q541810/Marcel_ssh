import { describe, expect, it } from 'vitest';
import { formatFolderUploadStatus } from './sftpUploadStatus';

describe('formatFolderUploadStatus', () => {
  it('formats preflight checking status', () => {
    expect(formatFolderUploadStatus({ uploadId: '1', phase: 'checking', percent: 5 })).toBe(
      '正在检查远端解压工具 5%',
    );
  });

  it('formats zipping status with overall percent', () => {
    expect(formatFolderUploadStatus({ uploadId: '1', phase: 'zipping', percent: 23 })).toBe(
      '正在压缩文件夹 23%',
    );
  });

  it('formats uploading status with byte progress and overall percent', () => {
    expect(
      formatFolderUploadStatus({
        uploadId: '1',
        phase: 'uploading',
        written: 1024,
        total: 2048,
        percent: 60,
      }),
    ).toBe('正在上传压缩包 1.0 KB / 2.0 KB 60%');
  });

  it('formats extracting status with overall percent', () => {
    expect(formatFolderUploadStatus({ uploadId: '1', phase: 'extracting', percent: 90 })).toBe(
      '正在远端解压，暂不可取消 90%',
    );
  });
});
