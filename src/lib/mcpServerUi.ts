/**
 * MCP Server 设置页的纯判定逻辑。
 *
 * 单独放这里而不是留在组件里：组件顶层引了 Tauri 的插件与 IPC 封装，
 * 在 node 测试环境导入即失败。仓库里 `agentStatus.ts` / `settingsLayout.ts`
 * 是同样的做法——与渲染无关、需要被测试钉住的判定，放 `lib/` 下的纯模块。
 */

/**
 * 绑定地址是否会把服务暴露到本机之外。
 *
 * 这条判定直接决定要不要显示那段红色的安全警告。漏判的后果不是「少个提示」，
 * 而是**真正暴露时警告反而消失**——所以 `::1`（IPv6 回环）与 `localhost`
 * 都必须在内。
 */
export function isExposedBind(bind: string): boolean {
  const v = bind.trim();
  if (v === '') return false;
  return v !== '127.0.0.1' && v !== '::1' && v !== 'localhost';
}

/** 端口输入净化：只留数字，避免 `Number('12a')` 这类静默变 NaN。 */
export function sanitizePortInput(raw: string): number {
  const digits = raw.replace(/\D/g, '');
  if (digits === '') return 0;
  return Number(digits);
}

/** 端口是否在可用范围内（后端只接受非 0 的 u16）。 */
export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}
