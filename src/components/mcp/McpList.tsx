/**
 * Custom MCP (Model Context Protocol) servers list.
 *
 * Placeholder for now — the full MCP integration is a later phase. This view
 * appears in the sidebar slot when the user clicks the MCP icon in the nav rail.
 */
export default function McpList() {
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
          自定义 MCP
        </h2>
        <button
          disabled
          className="p-1 rounded-lg text-zinc-600 cursor-not-allowed"
          title="新建 MCP（即将推出）"
          aria-label="新建 MCP"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 text-sm">
        <div className="text-center mt-6 px-2 space-y-2">
          <p className="text-zinc-500">尚未配置任何 MCP 服务器。</p>
          <p className="text-xs text-zinc-600">
            即将推出 — 在此处管理自定义的 MCP（Model Context Protocol）服务器，
            为智能助手扩展工具能力。
          </p>
        </div>
      </div>
    </div>
  );
}
