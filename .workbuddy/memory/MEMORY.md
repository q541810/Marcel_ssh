# MEMORY.md — Marcel SSH 项目长期笔记

## 自动同步（auto-sync）设计决策（维护者确认）
- **零知识与本地优先**：服务端只存 AES-256-GCM 密文 + 每 key 版本号，永不可见明文；API Key 仅存 SHA-256。用户本地客户端是数据真相源。
- **TLS 不强制**：面向个人部署，TLS 由用户/反代自管。服务端不拒绝 http、客户端不校验 https 是**设计选择**（非缺陷）。若未来做官方公网托管再评估。
- **每日清理（auth.cleanup_empty_accounts）**：仅当账户设备数=0 时 UTC 04:00 删除账户+快照，属**设计确认**——本地数据不受影响，重新配对可重传。不要改成"设备=0 且快照=0"。
- **账户删除（delete_account）无真正第二因子**：`account_id == config_code_hash`，`account_id != request.config_code_hash` 校验对合法调用者恒为真，仅是**一致性校验**。API Key = 完全账户访问权（泄露即可删账户）。文档须如实表述，不得声称"双因子"。
- **创建账户限流**：`/api/account/setup` = 3/60s（收紧垃圾账户）；`/api/account/join` 需有效 config_code_hash 且不创账户 = 5/60s。

## 审查交付物
- `D:\my\Marcel SSH\review-auto-sync.md`：自动同步全面审查报告（含第 9 节维护者反馈与修订）。
- 唯一 P0 遗留：C-F1 客户端 push 失败无自动重试。

## 引导（onboarding）架构（2026-07-24 重做）
- 两端引导均为三相位：`gate（同步账户门）→ restore（恢复）→ steps（内容步骤）`。恢复成功（pairJoin + 首轮 pull）直接 `hasCompletedOnboarding=true` 结束引导。
- 共享逻辑在 `src/components/onboarding/SyncRestore.tsx`（恢复流程状态机 form→syncing→done）；样式沿用原组件与配色，不要另起视觉系统。
- `hasCompletedOnboarding` / `hasAcceptedSyncDisclaimer` 不参与跨设备同步（profile.rs 映射 None），是纯本机标记。
- `src/lib/waitForInitialSync.ts`（waitForInitialSyncPull）：加入账户后等首轮 pull 落定（轮询 summary.state，90s 超时），任何"配对后立即进入"场景都应复用。
- 引导里只做"加入已有账户"；创建新账户（pairFirst + 手抄配置码）留在设置页。

## UI 变更风格要求（用户明确，2026-07-24）
- 简洁、干净、克制、现代化；尊重原有设计语言与代码结构：zinc 卡片（border-zinc-800 bg-zinc-900/50）、indigo-600 主按钮、既有文案词汇、既有动效类。
- 禁止"AI 味"发挥：渐变按钮、光晕/发光 logo、渐变文字、大面积错落动效、营销化/修饰性文案（如"开始之前"这类无中生有的标签）。
