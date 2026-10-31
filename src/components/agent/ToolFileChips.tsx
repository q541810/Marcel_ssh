import { toolFileRefs } from '@/lib/fileLink';
import FileLinkChip from './FileLinkChip';

/**
 * 工具卡片下方的路径芯片行：写 / 改 / 读文件、上传下载碰到的文件，点一下直接在文件管理里打开，
 * 右键（手机长按）出完整菜单。路径与机器取自工具调用的**结构化参数**，不依赖 markdown 约定。
 * 芯片不能放进卡片标题行：那一整行本身是展开 / 收起的按钮，按钮里不能再嵌按钮。
 */
export default function ToolFileChips({
  toolName,
  args,
}: {
  toolName: string;
  args: Record<string, unknown> | undefined;
}) {
  const refs = toolFileRefs(toolName, args);
  if (refs.length === 0) return null;
  return (
    <div className="ml-3 flex min-w-0 flex-wrap items-center gap-1.5 border-l border-edge/50 py-1 pl-3 pr-1.5 text-xs">
      {refs.map((ref) => (
        <FileLinkChip key={`${ref.side}:${ref.path}`} file={ref} className="text-[11px]" />
      ))}
    </div>
  );
}
