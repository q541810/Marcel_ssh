---
name: release
description: Marcel SSH 发布与发布工作流。更新版本号、构建、打标签、创建 GitHub Release、上传安装包。当用户说 "release"、"publish"、"发版"、"打包"、"build release"、"调整版本号" 或提到 version bump（版本升级）时使用。
---

# Marcel SSH 发布流程

## Release 描述偏好

- Release notes 要按用户能感知到的最终能力写，不要机械复述 commit。
- 功能发布前的内部迭代不要单独列出来，应合并进最终功能描述。
- 不写低价值发布流程信息。例如“Windows 继续只发布 NSIS，不发布 MSI”如果不是本版本新增注意事项，就不要写。
- 描述要具体对应问题本质，避免泛泛而谈。例如不要只写“工具卡片预览优化”，应写清楚“在探索 N 次搜索卡片判定中加入 `search_files`、`list_directory`”。
- 修复类描述要写清楚触发原因。例如探索折叠应说明“不渲染的空 assistant 消息打断连续探索工具判定”，再说明增加数值变化动画。
- 优化类要突出体验或性能收益。例如窗口 resize 应写“优化窗口尺寸调整时的响应速度/布局响应/动画表现，减少卡顿与闪烁”。
- 多个 commit 服务于同一个最终功能时，应合并成一个条目，避免暴露实现演进。
- 分类按用户视角归类：新增能力放“新功能”，体验/性能/判定逻辑改善放“优化”，具体 bug 放“修复”。不要因为 commit 前缀是 `feat` 就一定写成独立新功能。
- Release notes 按平台分节：`##` 标题写平台范围（`## 桌面端` / `## 移动端` / `## 桌面端 + 移动端`），平台节内的 `###` 写分类（新功能 / 优化 / 修复），同一平台的多分类合并到该平台节下。禁止 `### 新功能（桌面端）` 这种平台嵌在分类标题里的写法。示例：

  ```
  ## 桌面端 + 移动端

  ### 新功能
  - ...

  ### 优化
  - ...

  ## 移动端

  ### 修复
  - ...
  ```
- 可以保留技术细节，但必须服务于用户问题。例如 `DOM selector 解析 li.b_algo` 可以解释搜索串栏修复；debug、临时诊断和实现过程不要写。
- 文风可以有作者口吻、吐槽和情绪，但事实必须准确。优先“具体问题 + 具体效果”，不要 AI 模板化堆条目。

## 从 commit 提炼描述（禁止复述）

Release notes 的素材是 commit，但不是 commit 的转述。写每一条之前，先回答一个问题：**这个改动之后，用户在界面上能做什么、体验到什么、不再遇到什么**——答案就是这条描述；答不出来，说明这条不该单独出现。

### 提炼流程（每一条都走一遍）

1. 不要只看 commit title。用 `git show --stat` / `git show <sha>` 读 diff，确认改动真正改变的用户行为。commit title 是写给开发者的，release 是写给用户的。
2. 按三个问题归类：
   - 用户现在能做什么以前不能做的事 → **新功能**
   - 用户的体验 / 性能有什么可感知的变化 → **优化**
   - 用户遇到的什么毛病或困惑消失了 → **修复**
3. 用一句话写出来，主语是“用户”，不是“代码”。写完做两个自检：
   - 是不是把 commit title 换了种说法抄了一遍？是 → 还没提炼，重写。
   - 这句话放到任何软件的更新日志里都成立（“修复若干问题”“提升稳定性”）？是 → 太泛，回到第 1 步找具体行为。
4. 内部重构、debug 过程、为功能铺路的 commit 没有用户可感知的变化，**不单独列**，并入它服务的最终功能条目。

### 复述 vs 提炼（示例）

| commit | 复述（差） | 提炼（好） |
| --- | --- | --- |
| `fix: 探索折叠改为数值变化动画，修复空 assistant 消息打断连续探索判定` | 探索折叠改为数值变化动画，修复空 assistant 消息打断连续探索判定 | 修复 Agent 探索时卡片偶发无法连续展开/折叠的问题，并为折叠过程增加平滑过渡动画 |
| `refactor: 抽取 ssh 会话管理器，统一连接生命周期` | 抽取 ssh 会话管理器，统一连接生命周期 | （无用户可感知变化，不单独列；若带动连接稳定性提升，并入对应条目） |

技术细节（函数名、DOM selector、缓存策略）只有在解释“用户为什么之前会踩坑、现在为什么好了”时才保留，例如用 `DOM selector 解析 li.b_algo` 解释搜索串栏修复。

## 前置检查

- [ ] 所有代码已合入 `main` 分支
- [ ] 自测通过（`cargo test` + `pnpm tsc --noEmit`）
- [ ] **注意**：`pnpm tsc --noEmit` 会扫描 `*.test.ts` 文件。如果测试夹具的类型定义落后于 `src/lib/types.ts`，构建会失败。必须先修正测试文件的类型错误，不要跳过类型检查。

## 步骤

### 1. 检查最新版本

```bash
gh release list
```

### 2. 确认本版发布平台（桌面 / 安卓 / 两者）

先确认本版发布哪些平台，后续步骤全部按此执行：

- 桌面有变更 → 构建并上传 Windows 安装包，更新 `latest.json` **顶层**字段
- 安卓有变更 → 构建并上传 APK，更新 `latest.json` 的 **`android`** 字段
- 未发布的平台：**不构建、不上传、不更新 `latest.json` 对应字段**

### 3. 更新版本号

修改以下文件中的版本号。**全局共享一个版本号**：每次发布 bump 一次，与本次发布几个平台无关（例如只发安卓也 bump 一次，下版桌面从 `0.8.1` 直接到 `0.8.3` 是正常现象）：

| 文件                          | 字段                          |
| --------------------------- | --------------------------- |
| `src-tauri/tauri.conf.json` | `version`                   |
| `src-tauri/Cargo.toml`      | `version` (package section) |
| `package.json`              | `version`                   |
| `latest.json`               | 见下方“latest.json 更新规则”  |

> 改完 `Cargo.toml` 后 `Cargo.lock` 会自动更新，这是预期行为，一并提交。

#### latest.json 更新规则（谁发布谁写，没发的平台字段保持不动）

```json
{
  "version": "0.8.1",
  "release_url": "https://github.com/q541810/Marcel_ssh/releases/tag/v0.8.1",
  "android": {
    "version": "0.8.0",
    "release_url": "https://github.com/q541810/Marcel_ssh/releases/tag/v0.8.0"
  }
}
```

- 顶层 `version` / `release_url` = **桌面**平台最新发布版本
- `android.version` / `android.release_url` = **安卓**平台最新发布版本
- 发布桌面 → 只改顶层；发布安卓 → 只改 `android`；两端都发 → 都改
- **不要顺手把未发布平台的字段也改成新版本**——那会让该平台用户收到“有更新”提示但实际没有新包
- 客户端检查逻辑：桌面只对比顶层，安卓只对比 `android` 字段（`src-tauri/src/commands/update.rs` 的 `pick_latest`）；`android` 字段缺失时安卓回退读顶层（旧结构兼容，历史版本都是两端同步发布的）
- 首次引入 `android` 字段时（平台分离后的第一次发布），其值写当前已发布的最新安卓版本即可，不必两端同发

#### 版本号规则（语义化版本）

- **主版本 (MAJOR)**：不兼容的 API/功能变更（如 Agent 架构大改、SSH 协议变更）
- **次版本 (MINOR)**：向后兼容的功能新增（如新工具、新设置项）
- **修订号 (PATCH)**：向后兼容的 bug 修复（如 UI 修复、内存泄漏修复）
- 必须是标准三段式（如 `0.8.1`）。更新检查用 semver 严格解析，非标准版本号（如 `0.8.0.1`）会静默视为无更新，等于该平台用户永远收不到提示

### 4. 构建 Windows 安装包（仅本版发布桌面时执行）

```bash
pnpm tauri build
```

产物路径：

- `src-tauri/target/release/bundle/nsis/Marcel SSH_{version}_x64-setup.exe`

> Windows 默认只发布 NSIS 安装包，不发布 MSI，以控制安装包体积。

### 5. 构建 Android APK（仅本版发布安卓时执行）

```powershell
$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
$env:NDK_HOME="$env:LOCALAPPDATA\Android\Sdk\ndk\27.0.12077973"
pnpm tauri android build --apk --target aarch64
```

产物路径：

- `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`（**已自动用正式 keystore 签名**）

签名说明：

- keystore 在 `~/.android/marcel-ssh-release.keystore`（仓库外），密码在 `src-tauri/gen/android/app/key.properties`（已 gitignore）。两个文件都必须备份，丢了无法再对同一 app 签发更新。
- Gradle 侧 signingConfig 读 `key.properties`；文件缺失时 release 构建退化为未签名 APK，方便 CI 或新机器先跑通。
- 首次构建前需 `pnpm tauri android init` 生成 `gen/android` 工程（已提交进仓库，无需重复跑）。
- Gradle wrapper 走腾讯镜像（`gradle-wrapper.properties`），避免官方源证书问题。
- Android 的 versionName/versionCode（`tauri.properties`）由 tauri CLI 从 `tauri.conf.json` 的 `version` 自动生成，版本号递增保证 versionCode 单调递增，侧载升级不受影响。

### 6. 拟定release描述

按「从 commit 提炼描述」一节执行：先 `git log --oneline` 列出本版 commit，再对每个 commit `git show` 读 diff，逐条回答“用户得到什么”并归类到平台 + 新功能/优化/修复，合并同类项后按「Release 描述偏好」的格式与风格成文，最后再查看 release 记录、模仿之前的 release 描述风格，将定稿告知用户。

写完后自检：是否还有条目读起来像 commit title 的转述？有就重写。

如果本版只发布单一平台，描述第一行注明平台范围，并写明另一平台的去向，例如：

> 本版本无安卓更新内容，最新 APK 请前往旧 release 寻找。

（反向场景同样处理：只发安卓时注明桌面用户无需更新。）

### 7. 提交并打 tag

在用户确认6中你告知他的release描述后，提交并打 tag。

```bash
git add -A
git commit -m "chore: bump version to {version}"
git tag v{version}
git push origin main
git push origin v{version}
```

### 8. 创建 GitHub Release

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

### 9. 上传安装包到 Release Assets

按第 2 步确认的发布平台上传资产。发布桌面时：

```bash
gh release upload v{version} "src-tauri\target\release\bundle\nsis\Marcel SSH_{version}_x64-setup.exe" --clobber
```

发布安卓时一并上传 Android APK（重命名带架构，避免和 Windows 安装包混淆）：

```bash
gh release upload v{version} "src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk#Marcel-SSH_{version}_arm64.apk" --clobber
```

未发布平台的资产**不要上传**（与 `latest.json` 字段保持一致，避免用户跳转到该 release 却找不到对应平台的包）。

### 10. 发布后强制验证

发布完成后必须逐项核对，防止平台字段与资产不一致：

- [ ] `gh release view v{version}`：资产清单只包含本版实际发布的平台产物
- [ ] `gh release list`：最新 release 的 tag 与 `latest.json` 各字段对应
- [ ] `latest.json` 已 push 到 main 且内容正确：发布桌面的版本顶层字段 = 新版本；发布安卓的 `android.version` = 新版本；**未发布平台的字段保持原值，未被顺手改动**
- [ ] 在桌面端和安卓真机上分别验证：各手动点一次“检查更新”，确认只有发布了新版的平台提示有更新
