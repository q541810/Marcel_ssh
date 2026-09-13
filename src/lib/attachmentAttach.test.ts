import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isImageFileName,
  isTextFileName,
  classifyAttachment,
  base64ToBlob,
  decodeTextBytes,
  wrapTextAttachment,
  resolveAttachmentName,
  MAX_TEXT_FILE_BYTES,
} from "./attachmentAttach";

// resolveAttachmentName 走 invoke("agent_get_local_file_name")，单测里 mock 掉
// 桌面绝对路径和 Android SAF content:// URI 两种场景。
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: { path: string }) => invokeMock(cmd, args),
}));

describe("isImageFileName", () => {
  it("detects common image extensions case-insensitively", () => {
    expect(isImageFileName("photo.PNG")).toBe(true);
    expect(isImageFileName("a.jpg")).toBe(true);
    expect(isImageFileName("b.JPEG")).toBe(true);
    expect(isImageFileName("c.gif")).toBe(true);
    expect(isImageFileName("d.webp")).toBe(true);
    expect(isImageFileName("e.bmp")).toBe(true);
    expect(isImageFileName("f.ico")).toBe(true);
    expect(isImageFileName("g.tiff")).toBe(true);
  });

  it("rejects non-image names", () => {
    expect(isImageFileName("readme.md")).toBe(false);
    expect(isImageFileName("archive.tar.gz")).toBe(false);
    expect(isImageFileName("noext")).toBe(false);
    expect(isImageFileName("photo.tiffx")).toBe(false);
  });
});

describe("isTextFileName", () => {
  it("detects text-ish extensions", () => {
    expect(isTextFileName("readme.md")).toBe(true);
    expect(isTextFileName("server.log")).toBe(true);
    expect(isTextFileName("config.json")).toBe(true);
    expect(isTextFileName("notes.txt")).toBe(true);
    expect(isTextFileName("app.py")).toBe(true);
    expect(isTextFileName("style.css")).toBe(true);
    expect(isTextFileName("page.html")).toBe(true);
    expect(isTextFileName(".gitignore")).toBe(true);
    expect(isTextFileName("Dockerfile")).toBe(true);
  });

  it("rejects binary extensions", () => {
    expect(isTextFileName("photo.png")).toBe(false);
    expect(isTextFileName("app.exe")).toBe(false);
    expect(isTextFileName("archive.zip")).toBe(false);
    expect(isTextFileName("movie.mp4")).toBe(false);
    expect(isTextFileName("lib.so")).toBe(false);
  });
});

describe("classifyAttachment", () => {
  it("image extension wins over mime", () => {
    expect(classifyAttachment("a.png", "text/plain")).toBe("image");
  });

  it("text extension wins over mime", () => {
    expect(classifyAttachment("a.log", "application/octet-stream")).toBe(
      "text",
    );
  });

  it("falls back to mime for unknown extension", () => {
    expect(classifyAttachment("unknown.bin", "text/plain")).toBe("text");
    expect(classifyAttachment("unknown.bin", "image/png")).toBe("image");
  });

  it("unsupported when neither extension nor mime matches", () => {
    expect(classifyAttachment("movie.mp4", "video/mp4")).toBe("unsupported");
    expect(classifyAttachment("archive.zip", "")).toBe("unsupported");
  });
});

describe("base64ToBlob", () => {
  it("decodes raw base64", () => {
    const text = "hello";
    const blob = base64ToBlob(btoa(text), "text/plain");
    expect(blob.size).toBe(5);
    expect(blob.type).toBe("text/plain");
  });

  it("decodes data URL", () => {
    const blob = base64ToBlob("data:text/plain;base64," + btoa("abc"), "text/plain");
    expect(blob.size).toBe(3);
  });
});

describe("decodeTextBytes", () => {
  it("decodes utf-8", () => {
    const bytes = new TextEncoder().encode("你好 world");
    expect(decodeTextBytes(bytes)).toBe("你好 world");
  });

  it("falls back to gb18030 for gbk bytes", () => {
    // "中文" in GBK: D6 D0 CE C4
    const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    expect(decodeTextBytes(bytes)).toBe("中文");
  });

  it("keeps ascii as-is", () => {
    expect(decodeTextBytes(new Uint8Array([0x61, 0x62, 0x63]))).toBe("abc");
  });
});

describe("wrapTextAttachment", () => {
  it("wraps content with file name marker", () => {
    const out = wrapTextAttachment("notes.md", "line1\nline2");
    expect(out).toContain("===== 文件名: notes.md =====");
    expect(out).toContain("line1\nline2");
    expect(out.startsWith("\n\n")).toBe(true);
  });
});

describe("MAX_TEXT_FILE_BYTES", () => {
  it("is 5MB", () => {
    expect(MAX_TEXT_FILE_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe("resolveAttachmentName", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("asks backend for desktop absolute path basename", async () => {
    invokeMock.mockResolvedValueOnce("server.log");
    const name = await resolveAttachmentName("/home/me/docs/server.log");
    expect(name).toBe("server.log");
    expect(invokeMock).toHaveBeenCalledWith("agent_get_local_file_name", {
      path: "/home/me/docs/server.log",
    });
  });

  it("asks backend for Android SAF content:// URI (the bug fix)", async () => {
    // 真实的 Android DocumentsProvider 经常把最后一个路径段编码成 document id（如 `12345`），
    // 没有 .jpg 扩展名。之前用 split('/').pop() 在这种 URI 上只能拿到 `12345`，
    // classifyAttachment 没有扩展名 → 不是图片也不是已知文本 → 按未知扩展名走文本兜底
    // → 整张 JPEG 二进制当 UTF-8 塞进输入框 → 乱码。
    const contentUri =
      "content://com.android.externalstorage.documents/document/image%3A12345";
    invokeMock.mockResolvedValueOnce("Screenshot_2026-09-12.jpg");
    const name = await resolveAttachmentName(contentUri);
    expect(name).toBe("Screenshot_2026-09-12.jpg");
    expect(invokeMock).toHaveBeenCalledWith("agent_get_local_file_name", {
      path: contentUri,
    });
    // 关键：分类器拿到正确扩展名后是 image
    expect(classifyAttachment(name)).toBe("image");
    // 同样的 URI 用旧 split('/').pop() 只能拿到 `image%3A12345`（含百分号编码的
    // document id），没有已知扩展名 → 误判为 text
    const oldStyleName = contentUri.split(/[/\\]/).pop() || contentUri;
    expect(classifyAttachment(oldStyleName)).not.toBe("image");
  });

  it("falls back to last path segment when backend throws", async () => {
    invokeMock.mockRejectedValueOnce(new Error("unsupported on this platform"));
    const name = await resolveAttachmentName("/var/log/app.log");
    expect(name).toBe("app.log");
  });
});
