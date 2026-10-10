/**
 * attachmentAttach — Agent 输入框「添加图片和文件」的附件分拣工具。
 *
 * 职责：
 *  - 按文件名 / MIME 判定类型（图片 → 压缩预览；文本 → 独立附件）
 *  - 本地文件读取（桌面绝对路径 / Android SAF content:// URI 统一走后端 agent_read_local_file）
 *  - 文本解码：优先 UTF-8 严格，失败 fallback GBK/GB18030（Windows 常见 .log/.txt）
 *  - 粘贴/拖拽里的文本文件（Web 侧 File 对象）读字节后共用文本解码规则
 */

import type { DialogFilter } from "@tauri-apps/plugin-dialog";
import { agentGetLocalFileName, agentReadLocalFile } from "./tauri";
import { BINARY_EXTENSIONS } from "./constants";
import { getErrorMessage } from "./errors";

/** 文本单文件大小上限（前端先拦，后端还有 10MB 兜底）。 */
export const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
/** 所有入口使用相同的原始读取上限，图片压缩发生在这道检查之后。 */
export const MAX_ATTACHMENT_READ_BYTES = 10 * 1024 * 1024;
/** 包括读取中、失败待处理的条目，避免连续导入无限积累内存。 */
export const MAX_ATTACHMENTS = 10;

/** dialog 插件在 Android 可用字符串或结构化错误表示取消。 */
export function isAttachmentDialogCancelled(error: unknown): boolean {
  return /\b(?:cancelled|canceled|dismissed)\b|已取消|取消选择/i.test(getErrorMessage(error));
}

export function attachmentTooLargeMessage(name: string, limit: number): string {
  return `「${name}」超过 ${Math.round(limit / 1024 / 1024)} MB，无法添加`;
}

/**
 * 「添加图片和文件」系统选择器的过滤器（桌面 / 移动同一份）。
 *
 * 扩展名清单与 IMAGE_EXTENSIONS / TEXT_EXTENSIONS **有意不同**：选择器过滤器
 * 只列常见扩展名引导用户，「所有文件」兜底让冷门扩展名（如 .tsv / .cfg）也能
 * 被选进来 —— 分拣由 classifyAttachment 负责，过滤器不是安全边界。
 */
const PICKER_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"];
const PICKER_TEXT_EXTENSIONS = [
  "md", "txt", "log", "json", "yml", "yaml", "xml", "csv",
  "ini", "conf", "sh", "py", "js", "ts", "html", "css",
  "sql", "toml", "svg",
];

export const ATTACH_FILE_PICKER_FILTERS: DialogFilter[] = [
  { name: "图片和文本文件", extensions: [...PICKER_IMAGE_EXTENSIONS, ...PICKER_TEXT_EXTENSIONS] },
  { name: "图片", extensions: [...PICKER_IMAGE_EXTENSIONS] },
  { name: "文本", extensions: [...PICKER_TEXT_EXTENSIONS] },
  { name: "所有文件", extensions: ["*"] },
];

/**
 * 「不支持的文件类型已跳过：a、b、c 等 N 个」的文案构造。
 * 横幅一行放不下太多名字：最多列 3 个，其余用计数收口。
 */
export function unsupportedAttachmentHint(names: readonly string[]): string {
  const shown = names.slice(0, 3).join("、");
  const more = names.length > 3 ? ` 等 ${names.length} 个` : "";
  return `不支持的文件类型已跳过：${shown}${more}`;
}

/** 分拣结果：图片走预览压缩链路、文本独立保存为附件，其余明确提示后跳过。 */
export interface PartitionedAttachmentPaths {
  imagePaths: string[];
  textPaths: string[];
  /** 保留展示名而不是裸路径：提示文案只关心名字，调用方不用再自己取 basename。 */
  unsupported: { name: string }[];
}

/**
 * 把文件选择器返回的一组本地路径按附件类型分拣（桌面 / 移动同一份）。
 *
 * 先把每条路径的展示名解析出来（content:// URI 必须经后端 ContentResolver
 * 查 DISPLAY_NAME，不能用 split('/').pop() 拿 document id），再按真实扩展名分拣。
 * 否则 Android 上 .jpg 会被误判为文本，整张 JPEG 二进制当 UTF-8 解码塞进输入框 → 满屏乱码。
 */
export async function partitionAttachmentPaths(
  paths: string[],
): Promise<PartitionedAttachmentPaths> {
  const imagePaths: string[] = [];
  const textPaths: string[] = [];
  const unsupported: { name: string }[] = [];
  const resolved: { path: string; name: string; kind: AttachmentKind }[] =
    await Promise.all(
      paths.map(async (p) => {
        const name = await resolveAttachmentName(p);
        return { path: p, name, kind: classifyAttachment(name) };
      }),
    );
  for (const { path: p, name, kind } of resolved) {
    if (kind === "image") imagePaths.push(p);
    else if (kind === "text") textPaths.push(p);
    else unsupported.push({ name });
  }
  return { imagePaths, textPaths, unsupported };
}

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
  // UTF-16 的 BOM 是有依据的文本信号；其 NUL 字节不能误判为二进制。
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
  }
  const prefix = Array.from(bytes.subarray(0, 16), (byte) => String.fromCharCode(byte)).join("");
  const binarySignature =
    prefix.startsWith("%PDF-") || prefix.startsWith("PK\u0003\u0004") ||
    prefix.startsWith("\u0089PNG") || prefix.startsWith("\u00ff\u00d8\u00ff") ||
    prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a") ||
    prefix.startsWith("\u007fELF") || prefix.startsWith("\u001f\u008b") ||
    (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") ||
    prefix.slice(4, 8) === "ftyp";
  const sample = bytes.subarray(0, 8192);
  const controlCount = sample.reduce(
    (count, byte) => count + Number(byte < 32 && ![9, 10, 12, 13, 27].includes(byte)),
    0,
  );
  if (binarySignature || sample.includes(0) || (sample.length > 0 && controlCount / sample.length > 0.1)) {
    throw new Error("文件包含二进制数据，无法作为文本附件读取");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // GB18030 是 GBK 超集，能覆盖绝大多数中文 Windows 文本
    try {
      return new TextDecoder("gb18030", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("无法识别文件的文本编码，请转换为 UTF-8 后重试");
    }
  }
}

/** Blob → 文本（解码 Blob 内容）。 */
export async function blobToText(blob: Blob): Promise<string> {
  const buffer = typeof blob.arrayBuffer === "function"
    ? await blob.arrayBuffer()
    : await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(new Error("读取文件失败"));
      reader.readAsArrayBuffer(blob);
    });
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

/**
 * 解析本地路径对应的展示文件名（不读内容）。
 *
 * 桌面：直接取 basename。
 * Android SAF content:// URI：走后端 agent_get_local_file_name
 * （ContentResolver 查 DISPLAY_NAME，失败回退到 URI 段解码）。
 *
 * 文件选择器返回的路径在桌面是绝对路径、在 Android 是 content:// URI。
 * 如果用 `path.split('/').pop()` 这种简单做法取名，在 Android 上只能拿到
 * document id（如 `12345`）而非 `Screenshot_2026-...jpg`，导致 classifyAttachment
 * 看不到扩展名、退路误判为文本 → 整张 JPEG 二进制当 UTF-8 解码塞进输入框 → 满屏乱码。
 *
 * 调用方应在分类（图片 vs 文本）之前 await 拿到真实文件名。
 */
export async function resolveAttachmentName(path: string): Promise<string> {
  try {
    return await agentGetLocalFileName(path);
  } catch {
    // 后端失败（如非 Android、不支持的 scheme）兜底用最后一段
    return path.split(/[/\\]/).pop() || path;
  }
}
