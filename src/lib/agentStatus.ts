/**
 * agentStatus.ts —— 「任务状态属于哪一类」的前端判定入口。
 *
 * 为什么要单独一个模块：这条分类此前被抄在 **7 个文件 13 处**
 * （`agentStatusSelectors` 4、`sessionConversationBindingManager` 3、
 * `conversationStore` 2、`UpdatePill` 1、`useAgent` 1、`AgentMessageList` 1，
 * 外加 `taskStore` 的 `stopTask` 里那份 `["planning","executing","waiting_approval"]`
 * —— 最后这处是审查时才发现的，第一版注释漏了它；数字按
 * `rg -c "isTaskActive\(|isTaskBusy\("` 数。另有 **5 个文件**的单变体判断
 * （`AgentTasksDrawer` / `AgentStatusIndicator` / `MobileActiveAgentsSheet` /
 * `MobileTabBar` / `interactionStore`）**故意不迁**：单变体判断做成穷尽 switch
 * 没有意义），
 * 每处都是一串字面量比较。后端 `AgentStatus` 加一个状态位时，这些比较
 * **不会有任何编译或测试提示** —— 新状态会静默落进「既非 running 也非
 * waiting_approval」的兜底分支，界面上表现为 `'idle'`，一个正在跑的任务看起来
 * 像没事干。
 *
 * 措辞注意：它**不是**「唯一入口」—— 谓词只覆盖「按三状态分组」这一类判断；
 * 单变体判断（`status === 'waiting_approval'`）本来就该留在调用点，做成穷尽
 * `switch` 没有意义。`MobileTabBar` 就是这种情况，不在迁移范围内。
 *
 * 所以这里的谓词写成**穷尽 `switch`、不写 `default`**：`src/lib/types.ts` 的
 * `AgentStatus` 镜像一加成员，函数末尾就变成可达路径，TS 立刻报「函数可能返回
 * undefined」逼你回答新状态属于哪一类。这与后端 `AgentStatus::is_running()` 的
 * `match`（不写 `_ =>`）是同一条规矩的两半。
 *
 * 为什么放在 `lib` 而不是 `stores/agentStatusSelectors`：`conversationStore` 也要
 * 用这两个谓词，而 `agentStatusSelectors` 反过来 import 了 `conversationStore`；
 * 谓词放那边会形成 store 环（本仓库刚花一轮把环拆掉，见 tauriEvent 那轮）。
 * 这个模块**不 import 任何 store**，是纯叶子。
 */

import type { AgentStatus } from '@/lib/types';

/**
 * 任务正在消耗算力（planning / executing）。
 *
 * **刻意不含**「等待人工审批」：那个状态在界面上要单独表达（用户得去点批准），
 * 所以两个分组分开。合并会让「有个任务卡在审批上」看起来和「任务正在跑」一样。
 */
export function isTaskActive(status: AgentStatus): boolean {
  switch (status) {
    case 'planning':
    case 'executing':
      return true;
    case 'waiting_approval':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return false;
  }
}

/**
 * 任务占用 Agent 席位（含等待审批）—— 与后端 `AgentStatus::is_running()` 对应。
 *
 * 用于「这个对话/会话忙不忙」这类判定（决定气泡显示什么、退出应用前要不要拦）。
 */
export function isTaskBusy(status: AgentStatus): boolean {
  switch (status) {
    case 'planning':
    case 'executing':
    case 'waiting_approval':
      return true;
    case 'completed':
    case 'failed':
    case 'cancelled':
      return false;
  }
}
