import { useDebugStore, DEBUG_REASONING_EFFORTS } from "@/stores/debugStore";
import { effectiveModel, modelLabel, modelReasoningEfforts } from "@/lib/llmRegistry";
import type { AgentConversation, AgentMode, LlmRegistry, SessionStatus } from "@/lib/types";
import { AgentDraft, AgentTextarea } from "../AgentDraft";
import AgentCommandMenu, {
  type AgentCommandMenuHandle,
} from "../AgentCommandMenu";
import { ReasoningEffortPicker } from "../ReasoningEffortPicker";
import { notifyInputTyping } from "./inputActivity";
import type { AgentAttachments } from "@/hooks/useAgentAttachments";
import DraftAttachments from "../DraftAttachments";
import { ModeSelector } from "./ModeSelector";
import { SendControlButton } from "./SendControlButton";

type AgentComposerProps = {
  /** 双端共用附件 manager 的事件适配。 */
  attachments: AgentAttachments;
  mode: AgentMode;
  setMode: (mode: AgentMode) => void;
  isRunning: boolean;
  isCompacting: boolean;
  canInteract: boolean;
  /** activeSession?.status —— 占位文案按连接状态降级。 */
  activeSessionStatus: SessionStatus | undefined;
  commandMenuOpen: boolean;
  commandMenuRef: React.RefObject<AgentCommandMenuHandle>;
  /** 输入框 ref：发送失败回焦、插入技能、撤回回填都要聚焦它（父级持有）。 */
  inputRef: React.RefObject<HTMLTextAreaElement>;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onInsertSkill: (prompt: string) => void;
  onCompact: () => void;
  setInput: (text: string | ((prev: string) => string)) => void;
  registry: LlmRegistry;
  activeConversation: AgentConversation | null;
  activeConversationId: string | null;
  setConversationModel: (
    conversationId: string,
    modelId: string | null,
  ) => Promise<void>;
  setConversationEffort: (
    conversationId: string,
    reasoningEffort: string | null,
  ) => Promise<void>;
  onSend: () => void;
  onStop: () => void;
  onCancelCompaction: () => void;
};

/** 主对话输入区：拖拽/粘贴、`/` 命令面板、模式与模型选择、三态发送键。 */
export function AgentComposer({
  attachments,
  mode,
  setMode,
  isRunning,
  isCompacting,
  canInteract,
  activeSessionStatus,
  commandMenuOpen,
  commandMenuRef,
  inputRef,
  onKeyDown,
  onInsertSkill,
  onCompact,
  setInput,
  registry,
  activeConversation,
  activeConversationId,
  setConversationModel,
  setConversationEffort,
  onSend,
  onStop,
  onCancelCompaction,
}: AgentComposerProps) {
  const {
    dragOver,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleAttach,
    handlePaste,
  } = attachments;
  const forceReasoningEffortPicker = useDebugStore(
    (s) => s.forceReasoningEffortPicker,
  );

  return (
    <AgentDraft draftKey={attachments.draftKey}>{(input) => (
    <div
      className="flex-shrink-0 p-3 border-t border-zinc-800 [container-type:inline-size]"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="agent-content-column">
      {/* 压缩中常驻的原因说明：发送键这时是「取消压缩」，回车也发不出去，
          没有这一行用户只会觉得输入框坏了。配色跟随会话里那张进行中卡。 */}
      {isCompacting && (
        <div className="mb-2 flex items-center gap-2 px-2 py-1.5 rounded-md bg-violet-950/50 border border-violet-800/50 text-xs text-violet-200">
          <span className="h-2 w-2 shrink-0 rounded-full bg-violet-400/90" />
          正在压缩上下文，完成后即可发送（可点右下角取消）
        </div>
      )}
      <DraftAttachments attachments={attachments} />
      <div
        className={`agent-input relative rounded-2xl bg-zinc-800 border transition-colors focus-within:border-indigo-500 ${
          dragOver
            ? "border-indigo-400 ring-1 ring-indigo-500/40"
            : "border-zinc-700"
        }`}
      >
        {/* `/` 命令面板：锚定输入框上方，键盘事件由面板消费 */}
        <AgentCommandMenu
          ref={commandMenuRef}
          open={commandMenuOpen}
          query={commandMenuOpen ? input.slice(1) : ""}
          currentMode={mode}
          onSelectMode={setMode}
          onInsertSkill={onInsertSkill}
          onCompact={onCompact}
          onClose={() => setInput("")}
        />
        {/* Input field — 顶部整行，操作工具条移至下方 */}
        <AgentTextarea
          draftKey={attachments.draftKey}
          ref={inputRef}
          rows={1}
          maxHeight={96}
          onTyping={notifyInputTyping}
          onKeyDown={onKeyDown}
          onPaste={handlePaste}
          placeholder={
            activeSessionStatus === "connecting"
              ? "正在连接服务器..."
              : canInteract
                ? "描述您想要做的事情，输入 / 可查看命令..."
                : "请先连接到服务器..."
          }
          disabled={!canInteract}
          className="w-full px-4 pt-3 pb-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 bg-transparent outline-none focus:outline-none focus:ring-0 disabled:opacity-50 resize-none max-h-[6rem] overflow-y-auto leading-relaxed"
        />

        {/* Toolbar：+ 附件 / 模式 / 模型 —— 发送按钮右对齐 */}
        <div className="flex items-center px-1.5 pb-1.5">
          {/* + 附件按钮 — 图片/文本文件导入 */}
          <button
            type="button"
            onClick={() => void handleAttach()}
            disabled={!canInteract}
            className="flex-shrink-0 p-1.5 -ml-0.5 rounded-full text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/50 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-150 active:scale-90"
            title="添加图片或文本文件"
            aria-label="添加图片或文本文件"
          >
            <svg
              className="w-[18px] h-[18px]"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </button>
          {/* Mode selector — 空间不足时可收缩，文案窄时优先让位 */}
          <ModeSelector mode={mode} setMode={setMode} />

          {/* 模型设置：模型切换与思考强度合并为一个入口。 */}
          {(() => {
            // 生效模型语义：会话记忆 → 全局最近使用 → 首个
            const effModel = effectiveModel(registry, activeConversation?.modelId);
            const declaredEfforts = modelReasoningEfforts(effModel);
            const efforts = declaredEfforts.length > 0
              ? declaredEfforts
              : forceReasoningEffortPicker
                ? DEBUG_REASONING_EFFORTS
                : [];
            return (
              <ReasoningEffortPicker
                key={`${activeConversationId}:${effModel?.id}`}
                value={activeConversation?.reasoningEffort}
                efforts={efforts}
                modelName={modelLabel(effModel)}
                registry={registry}
                modelId={activeConversation?.modelId}
                onModelChange={(modelId) => {
                  if (!activeConversationId) return;
                  void setConversationModel(activeConversationId, modelId);
                }}
                onChange={(effort) => {
                  if (!activeConversationId) return;
                  return setConversationEffort(activeConversationId, effort);
                }}
                disabled={!canInteract || !activeConversationId}
              />
            );
          })()}

          <div className="flex-1" />

          <SendControlButton
            isRunning={isRunning}
            isCompacting={isCompacting}
            disabled={
              !isRunning &&
              !isCompacting &&
              ((!input.trim() && attachments.items.length === 0) || !!attachments.sendBlockedReason || !canInteract)
            }
            onSend={onSend}
            onStop={onStop}
            onCancelCompaction={onCancelCompaction}
          />
        </div>
      </div>
      </div>
    </div>
    )}</AgentDraft>
  );
}
