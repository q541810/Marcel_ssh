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
- [ ] 发布桌面时：用本地测试源把无感链路先跑一遍，别拿正式 release 当第一次真机验证 ——
      `node scripts/update-test-source.mjs`（或双击根目录 `update_test.cmd`）会起一个假更新源，
      配合 `MARCEL_LATEST_JSON_URL` 让客户端以为有新版；加 `--no-assets` 测「仅提示跳浏览器」降级、
      `--break-hash` 测校验失败提示、`--payload <真exe>` 测真实静默安装。
      **该钩子只在 debug 构建里编译进去**：客户端要用 `pnpm tauri dev`（桌面）/
      `pnpm tauri android dev`（安卓，且 `--android` 必须指向与已装客户端同一签名
      —— 即 debug keystore —— 签出的 APK，否则系统安装器会因签名不一致拒绝）。
      脚本会把客户端启动命令和观察点直接打出来。

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
  "version": "1.5.0",
  "release_url": "https://github.com/q541810/Marcel_ssh/releases/tag/v1.5.0",
  "installer_url": "https://github.com/q541810/Marcel_ssh/releases/download/v1.5.0/Marcel+SSH_1.5.0_x64-setup.exe",
  "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkuLi4=",
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "size": 15467892,
  "android": {
    "version": "1.5.0",
    "release_url": "https://github.com/q541810/Marcel_ssh/releases/tag/v1.5.0",
    "installer_url": "https://github.com/q541810/Marcel_ssh/releases/download/v1.5.0/Marcel-SSH_1.5.0_arm64.apk",
    "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "size": 45678901
  }
}
```

- 顶层 `version` / `release_url` = **桌面**平台最新发布版本
- `android.version` / `android.release_url` = **安卓**平台最新发布版本
- 发布桌面 → 只改顶层；发布安卓 → 只改 `android`；两端都发 → 都改
- **不要顺手把未发布平台的字段也改成新版本**——那会让该平台用户收到“有更新”提示但实际没有新包
- 客户端检查逻辑：桌面只对比顶层，安卓只对比 `android` 字段（`src-tauri/src/commands/update.rs` 的 `pick_latest`）；`android` 字段缺失时安卓回退读顶层（旧结构兼容，历史版本都是两端同步发布的）
- 首次引入 `android` 字段时（平台分离后的第一次发布），其值写当前已发布的最新安卓版本即可，不必两端同发
- **桌面无感更新扩展字段（写在顶层，仅发布桌面时更新）**：
  - `installer_url`：GitHub release 资产直链。注意资产文件名里的空格要转成 `+`（`Marcel SSH_1.5.0_x64-setup.exe` → `Marcel+SSH_1.5.0_x64-setup.exe`），浏览器地址栏复制到的就是转义后的形式
  - `signature`：第 4.5 步签名产出的 `.sig` 文件**完整内容**（一整行 base64）
  - `sha256`：`(Get-FileHash -Algorithm SHA256 "<exe>").Hash`（转小写或原样均可，客户端大小写不敏感）
  - `size`：`(Get-Item "<exe>").Length`
  - 这四个字段齐全时客户端才会走「后台静默下载 → 退出时自动安装」；任一缺失自动降级为旧的「提示跳浏览器」路径，旧版本客户端完全不受影响
  - `installer_mirrors`（可选数组）：安装包镜像直链，国内网络 fallback。客户端从 `installer_url` 开始逐个尝试，网络失败自动换下一个；**镜像不需要被信任**——内容由 sha256+签名校验兜底。有自建镜像（Cloudflare Workers 反代 / 对象存储）时填入，没有则省略
- **安卓无感更新扩展字段（写在 `android` 对象内，仅发布安卓时更新）**：
  - 字段：`installer_url`（APK 直链，同样把空格转成 `+`）、`sha256`、`size`，可选 `installer_mirrors`
  - **必须写在 `android` 对象内，不要写到顶层**：顶层的资产字段只属于桌面 NSIS 包。客户端严格按平台取（安卓只读 `android` 对象内的资产字段，绝不回退顶层），写错位置只会让安卓用户拿不到自动更新——不会装错包，但也修不好
  - **安卓不需要 `signature`**：系统安装器强制校验「新 APK 签名 == 已装版本签名」，签名不符根本装不上，比自校验更硬；`sha256` 只负责下载完整性
  - 三个字段（`installer_url`/`sha256`/`size`）齐全时才走「后台下载 → 一键安装」；缺任一自动降级为「提示跳浏览器」
  - 客户端只在**非计量网络**（Wi-Fi/以太网）下自动后台下载；移动数据下不自动下载（用户可在提示里点「后台下载」主动走流量）
- **检查源**：客户端依次尝试 GitHub raw 和 jsDelivr（`cdn.jsdelivr.net/gh/q541810/Marcel_ssh@main/latest.json`），raw 不通时 jsDelivr 兜底。jsDelivr 对 main 分支有数小时缓存，发布 latest.json 后可主动刷新缓存：`curl https://purge.jsdelivr.net/gh/q541810/Marcel_ssh@main/latest.json`

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

### 4.5 签名 Windows 安装包（仅本版发布桌面时执行；无感更新必需）

桌面无感更新要求安装包带 minisign 签名：客户端后台下载后先验签再静默安装，验签不过的包直接丢弃并降级为手动下载。

```powershell
# 密码必须用 --password= 显式传空串：PowerShell 里 $env:XXX="" 等于「删掉这个环境变量」，
# CLI 会当成没给密码，对加密密钥转去读控制台做交互输入（rpassword 读的是 CONIN$，管道与
# 重定向都喂不进去）→ 非交互 shell 里会静默卡死：只打印 "Signing without password." 之后
# 长时间无输出、CPU 也不动，看起来像签名挂了。所以别写 $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""。
$env:TAURI_SIGNING_PRIVATE_KEY_PATH="$env:USERPROFILE\.tauri\marcel-update.key"
pnpm tauri signer sign --password= "src-tauri\target\release\bundle\nsis\Marcel SSH_{version}_x64-setup.exe"
```

- 同目录产出 `Marcel SSH_{version}_x64-setup.exe.sig`，其完整内容写入 `latest.json` 的 `signature` 字段（签名不改动 exe 本体，上传资产时仍是同一个 exe）
- 签名密钥 `~/.tauri/marcel-update.key`（空密码）**必须备份**：丢失后无法再签出可被现有客户端接受的更新，只能换公钥发新版
- 公钥硬编码在 `src-tauri/src/updater/mod.rs` 的 `UPDATE_PUBKEY_B64`；换密钥就必须换公钥并发布带新公钥的版本
- 密钥本机也不存在时，先 `pnpm tauri signer generate -w "$env:USERPROFILE\.tauri\marcel-update.key" --password "" --ci` 生成，并把 `.pub` 的 base64 内容更新进 `UPDATE_PUBKEY_B64`（换钥发版场景：公钥要等下一次带新公钥的版本普及后才能启用对应私钥）
- 抄公钥时别抄错：`cargo test --lib updater::` 里的 `production_pubkey_parses` 会解析内置公钥，抄错直接测试失败（比线上全员静默更新失败好得多）

### 5. 构建 Android APK（仅本版发布安卓时执行）

```powershell
$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
$env:NDK_HOME="$env:LOCALAPPDATA\Android\Sdk\ndk\27.0.12077973"
pnpm tauri android build --apk --target aarch64
```

产物路径：

- `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`（**已自动用正式 keystore 签名**）

构建完先核对 R8 没把 JNI 入口点裁掉（release 开着 `isMinifyEnabled`，这个问题只有 release 产物看得见）：

```powershell
$m = "src-tauri\gen\android\app\build\outputs\mapping\universalRelease\mapping.txt"
Select-String -Path $m -Pattern "installUpdateApk|networkMetered" | % { $_.Line.Trim() }
```

期望打出两行方法名；**输出为空 = 方法被 R8 删了**，这种包发出去点「立即安装」只会报 `Java exception was thrown`（v1.4.1 踩过）。保留规则在 `src-tauri/gen/android/app/proguard-rules.pro`。

写入 `latest.json` 的安卓资产字段：

```powershell
$apk = "src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk"
(Get-FileHash -Algorithm SHA256 $apk).Hash   # → android.sha256
(Get-Item $apk).Length                       # → android.size
```

签名说明：

- keystore 在 `~/.android/marcel-ssh-release.keystore`（仓库外），密码在 `src-tauri/gen/android/app/key.properties`（已 gitignore）。两个文件都必须备份，丢了无法再对同一 app 签发更新。
- Gradle 侧 signingConfig 读 `key.properties`；文件缺失时 release 构建退化为未签名 APK，方便 CI 或新机器先跑通。
- 首次构建前需 `pnpm tauri android init` 生成 `gen/android` 工程（已提交进仓库，无需重复跑）。
- Gradle wrapper 走腾讯镜像（`gradle-wrapper.properties`），避免官方源证书问题。
- Android 的 versionName/versionCode（`tauri.properties`）由 tauri CLI 从 `tauri.conf.json` 的 `version` 自动生成，版本号递增保证 versionCode 单调递增，侧载升级不受影响。**顺序必须是先 bump 再构建**：v1.4.1 那次是先构建后 bump，同一份 APK 就当 1.4.1 发出去了，包内其实还是 versionName 1.4.0 / versionCode 1004000（核对 `app/build/outputs/apk/universal/release/output-metadata.json`）。
- 应用内更新依赖 manifest 里的 `REQUEST_INSTALL_PACKAGES`（已在 `gen/android/app/src/main/AndroidManifest.xml` 声明）与 `FileProvider`（`cache-path "."` 覆盖 cacheDir，更新包就落在 `cacheDir/update/`）。**不要删这两项**：删了系统连「安装未知应用」开关都不会列出来，应用内安装直接失败。
- 还有一条 keep 规则不能删：`MainActivity.installUpdateApk` / `networkMetered` 是被 Rust 用 JNI 按「名字 + 签名」反射调用的，靠 `gen/android/app/proguard-rules.pro` 里的 `-keep` 规则保留。release 构建会把没有 keep 规则的非 native 方法整个删掉（不是改名）：release 包点「立即安装」直接失败、Wi-Fi 下也不再自动后台下载，而 debug 包复现不出来——本步构建后那条 `mapping.txt` 检查就是查它。
- 用户在系统安装界面确认安装时，系统会顺手校验「签名一致 + versionCode 递增」，这两个前提由上面的 keystore 与版本号规则共同保证。

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

> **上传后必须核对真实资产名**：`gh release upload` 的 `路径#目标名` 重命名在部分 shell 下**不会生效**（实测 PowerShell 里会静默按原文件名上传，APK 就叫 `app-universal-release.apk`）。上传完立刻 `gh release view v{version} --json assets` 看实际名字，`latest.json` 的 `installer_url` **按核对后的真实文件名**拼；名字对不上 = 客户端下载 404、更新直接失败。Windows 安装包经 gh 上传后空格会变成点（`Marcel.SSH_{version}_x64-setup.exe`），照实写进 URL 即可；要保留 `Marcel-SSH_...apk` 这种名字，就先把文件本地复制成目标名再上传。

### 10. 发布后强制验证

发布完成后必须逐项核对，防止平台字段与资产不一致：

- [ ] `gh release view v{version}`：资产清单只包含本版实际发布的平台产物
- [ ] `gh release list`：最新 release 的 tag 与 `latest.json` 各字段对应
- [ ] `latest.json` 已 push 到 main 且内容正确：发布桌面的版本顶层字段 = 新版本；发布安卓的 `android.version` = 新版本；**未发布平台的字段保持原值，未被顺手改动**
- [ ] 发布桌面时：`installer_url` 可直接下载（HTTP 200），`sha256` 与实际 exe 的 `Get-FileHash` 一致，`size` 与 exe 字节数一致
- [ ] 发布安卓时：`android.installer_url` 可直接下载（HTTP 200），`android.sha256` / `android.size` 与 APK 一致；**不是**写到了顶层
- [ ] 发布桌面时：真机验证无感链路——上一个版本客户端等检查（或设置页手动「检查更新」→「后台下载」）→ 标题栏药丸出现并显示进度 → 下载完成后正常退出应用 → 安装器静默运行（**自然退出不自动重启应用**，手动打开后版本号 = 新版本）；再验证药丸气泡「立即安装」→ 退出安装后**自动重启**到新版本；顺带确认药丸「稍后」文案说明了「退出时仍会自动安装」
- [ ] 发布安卓时：真机验证无感链路——上一个版本客户端在 Wi-Fi 下等自动检查（或设置页「检查更新」→「后台下载」）→ 顶部出现细进度条 → 下载完成后弹出「新版本已就绪」浮层 → 点「立即安装」→ 系统安装界面确认 → 重启后版本号 = 新版本；再验证移动数据下**不**自动下载、点「后台下载」可以手动下载；首次安装前应出现「安装未知应用」授权引导
- [ ] 在桌面端和安卓真机上分别验证：各手动点一次“检查更新”，确认只有发布了新版的平台提示有更新
