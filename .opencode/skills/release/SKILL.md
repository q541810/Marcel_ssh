---
name: release
description: Marcel SSH release & publishing workflow. Bump versions, build, tag, create GitHub Release, upload installers. Use when user says "release", "publish", "发版", "打包", "build release", or mentions version bump.
---

# Marcel SSH 发布流程

## 前置检查

- [ ] 所有代码已合入 `main` 分支
- [ ] 自测通过（`cargo test` + `pnpm tsc --noEmit`）

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
| `package.json` | `version` |
| `latest.json` | `version` |

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
- `src-tauri/target/release/bundle/msi/Marcel SSH_{version}_x64_zh-CN.msi`

### 4. 提交并打 tag

```bash
git add -A
git commit -m "chore: bump version to {version}"
git tag v{version}
git push origin main
git push origin v{version}
```

### 5. 创建 GitHub Release

```bash
gh release create v{version} --title "v{version}" --notes "<changelog>"
```

### 6. 上传安装包到 Release Assets

将 `pnpm tauri build` 产出的 exe 和 msi 上传到刚创建的 Release 页面。