---
name: release
description: Marcel SSH 发布与发布工作流。更新版本号、构建、打标签、创建 GitHub Release、上传安装包。当用户说 "release"、"publish"、"发版"、"打包"、"build release"、"调整版本号" 或提到 version bump（版本升级）时使用。
---

# Marcel SSH 发布流程

## Release 描述偏好

- Release notes 要按用户能感知到的最终能力写，不要机械复述 commit。
- 功能发布前的内部迭代不要单独列出来，应合并进最终功能描述。例如鞭子浮字是“鞭子功能”的最终表现，不要写成独立新功能，也不要写“不会再污染输入框”这种内部改动痕迹。
- 不写低价值发布流程信息。例如“Windows 继续只发布 NSIS，不发布 MSI”如果不是本版本新增注意事项，就不要写。
- 描述要具体对应问题本质，避免泛泛而谈。例如不要只写“工具卡片预览优化”，应写清楚“在探索 N 次搜索卡片判定中加入 `search_files`、`list_directory`”。
- 修复类描述要写清楚触发原因。例如探索折叠应说明“不渲染的空 assistant 消息打断连续探索工具判定”，再说明增加数值变化动画。
- 优化类要突出体验或性能收益。例如窗口 resize 应写“优化窗口尺寸调整时的响应速度/布局响应/动画表现，减少卡顿与闪烁”。
- 多个 commit 服务于同一个最终功能时，应合并成一个条目，避免暴露实现演进。
- 分类按用户视角归类：新增能力放“新功能”，体验/性能/判定逻辑改善放“优化”，具体 bug 放“修复”。不要因为 commit 前缀是 `feat` 就一定写成独立新功能。
- 可以保留技术细节，但必须服务于用户问题。例如 `DOM selector 解析 li.b_algo` 可以解释搜索串栏修复；debug、临时诊断和实现过程不要写。
- 文风可以有作者口吻、吐槽和情绪，但事实必须准确。优先“具体问题 + 具体效果”，不要 AI 模板化堆条目。

## 前置检查

- [ ] 所有代码已合入 `main` 分支
- [ ] 自测通过（`cargo test` + `pnpm tsc --noEmit`）
- [ ] **注意**：`pnpm tsc --noEmit` 会扫描 `*.test.ts` 文件。如果测试夹具的类型定义落后于 `src/lib/types.ts`，构建会失败。必须先修正测试文件的类型错误，不要跳过类型检查。

## 步骤

### 1. 检查最新版本

```bash
gh release list
```

### 2. 更新版本号

修改以下文件中的版本号：

| 文件 | 字段 |
|------|------|
| `src-tauri/tauri.conf.json` | `version` |
| `src-tauri/Cargo.toml` | `version` (package section) |
| `package.json` | `version` |
| `latest.json` | `version`、`release_url` |

> 改完 `Cargo.toml` 后 `Cargo.lock` 会自动更新，这是预期行为，一并提交。

#### 版本号规则（语义化版本）

- **主版本 (MAJOR)**：不兼容的 API/功能变更（如 Agent 架构大改、SSH 协议变更）
- **次版本 (MINOR)**：向后兼容的功能新增（如新工具、新设置项）
- **修订号 (PATCH)**：向后兼容的 bug 修复（如 UI 修复、内存泄漏修复）

### 3. 构建安装包

```bash
pnpm tauri build
```

产物路径：
- `src-tauri/target/release/bundle/nsis/Marcel SSH_{version}_x64-setup.exe`

> Windows 默认只发布 NSIS 安装包，不发布 MSI，以控制安装包体积。

### 4. 拟定release描述
先阅读commit记录，再查看release记录，模仿之前的release描述风格，根据commit记录确定当前版本的描述后告知用户。

### 5. 提交并打 tag
在用户确认4中你告知他的release描述后，提交并打 tag。

```bash
git add -A
git commit -m "chore: bump version to {version}"
git tag v{version}
git push origin main
git push origin v{version}
```

### 6. 创建 GitHub Release

先将 release 描述写入临时文件，**必须用 UTF-8 编码**（`Set-Content` 默认 UTF-16LE 会导致中文乱码）：

```powershell
# PowerShell：用 WriteAllText + UTF8 编码，不要用 Set-Content
[System.IO.File]::WriteAllText("release-notes.md", @"
<changelog>
"@, [System.Text.Encoding]::UTF8)
```

```bash
gh release create v{version} --title "v{version}" --notes-file release-notes.md
```

创建完成后删除临时文件：
```bash
Remove-Item -LiteralPath release-notes.md
```

### 7. 上传安装包到 Release Assets

```bash
gh release upload v{version} "src-tauri\target\release\bundle\nsis\Marcel SSH_{version}_x64-setup.exe" --clobber
```
