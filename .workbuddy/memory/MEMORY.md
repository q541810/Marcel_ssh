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
