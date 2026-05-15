/**
 * 为 CRUD 操作添加 loading/error 状态管理的包装器。
 * 自动处理 try/catch/finally 设置 loading 和 error 状态。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withLoading(set: any, fn: () => Promise<void>): Promise<void> {
  set({ loading: true, error: null });
  return fn()
    .catch((err: unknown) => {
      set({ error: String(err) });
    })
    .finally(() => set({ loading: false }));
}
