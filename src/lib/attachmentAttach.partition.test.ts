import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ATTACH_FILE_PICKER_FILTERS,
  classifyAttachment,
  partitionAttachmentPaths,
  unsupportedAttachmentHint,
} from "./attachmentAttach";

// partitionAttachmentPaths 经 resolveAttachmentName 走 invoke("agent_get_local_file_name")，
// 单测里 mock 掉桌面绝对路径和 Android SAF content:// URI 两种场景。
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: { path: string }) => invokeMock(cmd, args),
}));

describe("ATTACH_FILE_PICKER_FILTERS", () => {
  it("has the three filters in order: 图片 / 文本 / 所有文件", () => {
    expect(ATTACH_FILE_PICKER_FILTERS.map((f) => f.name)).toEqual([
      "图片",
      "文本",
      "所有文件",
    ]);
  });

  it("every filter has a name and at least one extension; catch-all is '*'", () => {
    for (const filter of ATTACH_FILE_PICKER_FILTERS) {
      expect(filter.name.trim().length).toBeGreaterThan(0);
      expect(filter.extensions.length).toBeGreaterThan(0);
      for (const ext of filter.extensions) {
        expect(ext).toBe(ext.trim().toLowerCase());
      }
    }
    expect(ATTACH_FILE_PICKER_FILTERS[2].extensions).toEqual(["*"]);
  });

  it("listed extensions are all classifiable (filter guides, never blocks)", () => {
    for (const filter of ATTACH_FILE_PICKER_FILTERS.slice(0, 2)) {
      for (const ext of filter.extensions) {
        expect(classifyAttachment(`file.${ext}`)).not.toBe("unsupported");
      }
    }
  });
});

describe("partitionAttachmentPaths", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("buckets image / text / unsupported by resolved display name", async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: { path: string }) =>
      args.path.split("/").pop() || args.path,
    );

    const result = await partitionAttachmentPaths([
      "/home/me/shot.png",
      "/home/me/notes.md",
      "/home/me/movie.mp4",
      "/home/me/notes.md",
    ]);

    expect(result.imagePaths).toEqual(["/home/me/shot.png"]);
    // 保持输入顺序，重复条目不去重（分拣只分类，不做集合语义）
    expect(result.textPaths).toEqual(["/home/me/notes.md", "/home/me/notes.md"]);
    expect(result.unsupported).toEqual([{ name: "movie.mp4" }]);
  });

  it("asks the backend for the display name of Android SAF content:// URIs", async () => {
    const contentUri =
      "content://com.android.externalstorage.documents/document/image%3A12345";
    invokeMock.mockResolvedValueOnce("Screenshot_2026-09-12.jpg");

    const result = await partitionAttachmentPaths([contentUri]);

    expect(invokeMock).toHaveBeenCalledWith("agent_get_local_file_name", {
      path: contentUri,
    });
    // document id（`image%3A12345`）没有已知扩展名会被当成文本；展示名才能救回图片分支
    expect(result.imagePaths).toEqual([contentUri]);
    expect(result.textPaths).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it("falls back to the last path segment when the backend throws", async () => {
    invokeMock.mockRejectedValue(new Error("unsupported on this platform"));

    const result = await partitionAttachmentPaths(["/var/log/app.log"]);

    expect(result.textPaths).toEqual(["/var/log/app.log"]);
    expect(result.unsupported).toEqual([]);
  });

  it("returns empty buckets for empty input", async () => {
    const result = await partitionAttachmentPaths([]);
    expect(result).toEqual({ imagePaths: [], textPaths: [], unsupported: [] });
  });
});

describe("unsupportedAttachmentHint", () => {
  it("lists all names when at most three", () => {
    expect(unsupportedAttachmentHint(["a.zip"])).toBe(
      "不支持的文件类型已跳过：a.zip",
    );
    expect(unsupportedAttachmentHint(["a.zip", "b.exe", "c.pdf"])).toBe(
      "不支持的文件类型已跳过：a.zip、b.exe、c.pdf",
    );
  });

  it("caps the list at three and appends the total count", () => {
    expect(
      unsupportedAttachmentHint(["a.zip", "b.exe", "c.pdf", "d.bin"]),
    ).toBe("不支持的文件类型已跳过：a.zip、b.exe、c.pdf 等 4 个");
  });
});
