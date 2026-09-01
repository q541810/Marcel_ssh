/**
 * attachmentAttach — Agent 输入框「添加图片和文件」的附件分拣工具。
 *
 * 职责：
 *  - 按文件名 / MIME 判定类型（图片 → 走 imageAttach 压缩预览链路；文本 → 解码插入输入框）
 *  - 本地文件读取（桌面绝对路径 / Android SAF content:// URI 统一走后端 agent_read_local_file）
 *  - 文本解码：优先 UTF-8 严格，失败 fallback GBK/GB18030（Windows 常见 .log/.txt）
 *  - 粘贴/拖拽里的文本文件（Web 侧 File 对象）直接 file.text() 读取
 */

import { agentReadLocalFile } from "./tauri";
import { BINARY_EXTENSIONS } from "./constants";

/** 文本单文件大小上限（前端先拦，后端还有 10MB 兜底）。 */
export const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "tiff",
  "avif",
]);

const TEXT_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "log",
  "json",
  "yml",
  "yaml",
  "xml",
  "csv",
  "tsv",
  "ini",
  "conf",
  "cfg",
  "toml",
  "sh",
  "bash",
  "zsh",
  "fish",
  "py",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "sql",
  "env",
  "gitignore",
  "dockerfile",
  "svg",
  "properties",
  "gradle",
  "lock",
  "gitkeep",
]);

const IMAGE_MIME_PREFIX = "image/";
const TEXT_MIME_PREFIX = "text/";

function fileExtension(name: string): string {
  const lower = name.toLowerCase().trim();
  const idx = lower.lastIndexOf(".");
  if (idx < 0 || idx === lower.length - 1) return "";
  return lower.slice(idx + 1);
}

/** 按文件名判定是否为图片。 */
export function isImageFileName(name: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(name));
}

/** 常见无扩展名文本文件（大小写不敏感）。 */
const EXTENSIONLESS_TEXT_NAMES = new Set([
  "dockerfile",
  "makefile",
  "license",
  "readme",
  "changelog",
  "contributing",
  "procfile",
  "gemfile",
  "rakefile",
]);

/** 按文件名判定是否为可导入文本。 */
export function isTextFileName(name: string): boolean {
  const ext = fileExtension(name);
  if (TEXT_EXTENSIONS.has(ext)) return true;
  // 纯文本大类（.text）也视为文本
  if (ext === "text") return true;
  // 无扩展名但属于常见文本文件名（如 Dockerfile）
  const lower = name.toLowerCase().trim();
  if (EXTENSIONLESS_TEXT_NAMES.has(lower)) return true;
  return false;
}

/** 按 MIME 判定：text/* 视为文本，image/* 视为图片。 */
export function classifyByMime(mime: string): "image" | "text" | null {
  if (!mime) return null;
  if (mime.startsWith(IMAGE_MIME_PREFIX)) return "image";
  if (mime.startsWith(TEXT_MIME_PREFIX)) return "text";
  return null;
}

export type AttachmentKind = "image" | "text" | "unsupported";

/** 是否为已知二进制扩展名（黑名单，带点前缀，如 .zip/.exe/.pdf）。 */
export function isBinaryExtensionName(name: string): boolean {
  const ext = fileExtension(name);
  if (!ext) return false;
  return BINARY_EXTENSIONS.has(`.${ext}`);
}

/** 综合判定附件类型：扩展名优先，未知扩展名回落 MIME，再回落二进制黑名单。 */
export function classifyAttachment(
  name: string,
  mime?: string | null,
): AttachmentKind {
  if (isImageFileName(name)) return "image";
  if (isTextFileName(name)) return "text";
  // 扩展名不认识但 MIME 明确 → 按 MIME 走（如剪贴板里无扩展名的 text/* 文件）
  const byMime = classifyByMime(mime ?? "");
  if (byMime === "image") return "image";
  if (byMime === "text") return "text";
  // 未知扩展名：不是已知二进制格式 → 视为文本。避免 .eslintrc / .npmrc /
  // 无扩展名文件等实际是文本的文件被静默丢弃（对齐 mobile filesUi 的黑名单思路）
  if (!isBinaryExtensionName(name)) return "text";
  return "unsupported";
}

/** base64 → Blob（data URL 或裸 base64 均可）。 */
export function base64ToBlob(
  base64: string,
  mime = "application/octet-stream",
): Blob {
  const raw = base64.includes(",")
    ? base64.slice(base64.indexOf(",") + 1)
    : base64;
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/** 文本解码：UTF-8 严格优先，失败 fallback GBK/GB18030（Windows 常见编码）。 */
export function decodeTextBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // GB18030 是 GBK 超集，能覆盖绝大多数中文 Windows 文本
    return new TextDecoder("gb18030").decode(bytes);
  }
}

/** Blob → 文本（解码 Blob 内容）。 */
export async function blobToText(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  return decodeTextBytes(new Uint8Array(buffer));
}

/** 将文本文件包装成带文件名标记的输入框内容。 */
export function wrapTextAttachment(name: string, content: string): string {
  return `\n\n===== 文件名: ${name} =====\n${content}`;
}

/** 读取本地文件（含 Android SAF content://），经后端 agent_read_local_file。 */
export async function readLocalAttachment(
  path: string,
): Promise<{ name: string; base64: string; size: number }> {
  return agentReadLocalFile(path);
}
