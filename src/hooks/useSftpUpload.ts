import { useState, useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { readFile, readDir } from '@tauri-apps/plugin-fs';
import { zip } from 'fflate';
import { sftpUploadFolder } from '@/lib/tauri';
import { formatSize } from '@/lib/sftp-helpers';

async function collectFiles(dirPath: string, basePath: string): Promise<{ name: string; data: Uint8Array }[]> {
  const items: { name: string; data: Uint8Array }[] = [];
  const dirEntries = await readDir(dirPath);
  for (const entry of dirEntries) {
    const fullPath = `${dirPath}/${entry.name}`;
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      const subItems = await collectFiles(fullPath, relativePath);
      items.push(...subItems);
    } else if (entry.isFile) {
      const data = await readFile(fullPath);
      items.push({ name: relativePath, data });
    }
  }
  return items;
}

export function useSftpUpload(sessionId: string, remotePath: string) {
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);

  const uploadFolder = useCallback(async () => {
    try {
      const folderPath = await open({
        directory: true,
        title: '选择文件夹',
      });
      if (!folderPath) return;

      const path = Array.isArray(folderPath) ? folderPath[0] : folderPath;
      const folderName = path.split(/[/\\]/).pop() || 'upload';

      setUploadStatus('正在读取文件...');
      const files = await collectFiles(path, '');
      if (files.length === 0) {
        setUploadStatus(null);
        return;
      }

      setUploadStatus(`正在压缩 ${files.length} 个文件...`);
      const fileMap: Record<string, Uint8Array> = {};
      for (const f of files) {
        fileMap[f.name] = f.data;
      }
      const zipped = await new Promise<Uint8Array>((resolve, reject) => {
        zip(fileMap, { level: 6 }, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      });

      const MAX_SIZE = 32 * 1024 * 1024;
      if (zipped.length > MAX_SIZE) {
        setUploadStatus(null);
        throw new Error(`压缩包过大 (${formatSize(zipped.length)})，最大支持 32MB`);
      }

      setUploadStatus(`正在上传 ${formatSize(zipped.length)}...`);
      const targetPath = remotePath === '/' ? `/${folderName}` : `${remotePath}/${folderName}`;
      await sftpUploadFolder(sessionId, targetPath, Array.from(zipped));
      setUploadStatus(null);
    } catch (e) {
      setUploadStatus(null);
      throw e;
    }
  }, [sessionId, remotePath]);

  return { uploadFolder, uploadStatus };
}
