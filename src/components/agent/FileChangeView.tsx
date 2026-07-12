import { memo, useRef, useEffect } from 'react';
import { diffLines } from 'diff';

interface Props {
  toolName: 'write_file' | 'edit_file';
  arguments: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

type DiffRow = {
  left: string | null;
  right: string | null;
  type: 'unchanged' | 'removed' | 'added';
};

function buildDiffRows(oldText: string, newText: string): DiffRow[] {
  const changes = diffLines(oldText, newText);
  const rows: DiffRow[] = [];

  let i = 0;
  while (i < changes.length) {
    const change = changes[i];
    const lines = change.value.split('\n');
    const cleanLines = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;

    if (!change.added && !change.removed) {
      for (const line of cleanLines) {
        rows.push({ left: line, right: line, type: 'unchanged' });
      }
      i++;
    } else if (change.removed) {
      const nextChange = changes[i + 1];

      if (nextChange?.added) {
        const addedStr = nextChange.value;
        const addedLines = addedStr.split('\n');
        const cleanAdded = addedLines[addedLines.length - 1] === '' ? addedLines.slice(0, -1) : addedLines;
        const maxLen = Math.max(cleanLines.length, cleanAdded.length);

        for (let j = 0; j < maxLen; j++) {
          const leftLine = cleanLines[j] ?? null;
          const rightLine = cleanAdded[j] ?? null;
          rows.push({ left: leftLine, right: rightLine, type: leftLine ? 'removed' : 'added' });
        }
        i += 2;
      } else {
        for (const line of cleanLines) {
          rows.push({ left: line, right: null, type: 'removed' });
        }
        i++;
      }
    } else {
      for (const line of cleanLines) {
        rows.push({ left: null, right: line, type: 'added' });
      }
      i++;
    }
  }

  return rows;
}

function splitContent(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    return lines.slice(0, -1);
  }
  return lines;
}

function findLineIdx(content: string, target: string): number {
  if (!target) return 0;
  const idx = content.indexOf(target);
  if (idx === -1) return 0;
  return content.substring(0, idx).split('\n').length - 1;
}

function DiffRowView({ row, dataLine }: { row: DiffRow; dataLine?: number }) {
  const isChanged = row.type !== 'unchanged';
  const leftHasContent = row.left !== null;
  const rightHasContent = row.right !== null;

  const leftBg = (isChanged && leftHasContent) ? 'bg-red-950/30' : '';
  const rightBg = (isChanged && rightHasContent) ? 'bg-emerald-950/40' : '';
  const leftText = (isChanged && leftHasContent) ? 'text-red-300' : 'text-zinc-400';
  const rightText = (isChanged && rightHasContent) ? 'text-emerald-200' : 'text-zinc-300';

  let marker: string;
  if (row.left !== null && row.right !== null) marker = '~';
  else if (row.left !== null) marker = '-';
  else marker = '+';

  return (
    <div className="flex min-w-max" data-line={dataLine}>
      <span className="flex-shrink-0 w-10 text-right pr-2 select-none border-r border-zinc-700/50 font-mono text-xs">
        {row.left !== null ? (
          <span className="text-red-400">{marker}</span>
        ) : (
          <span className="text-green-400">{marker}</span>
        )}
      </span>
      <div className={`flex-1 border-r border-zinc-700/50 ${leftBg}`}>
        {row.left !== null ? (
          <span className={`whitespace-pre block px-2 font-mono text-xs ${leftText}`}>{row.left}</span>
        ) : (
          <span className="block px-2">&nbsp;</span>
        )}
      </div>
      <div className={`flex-1 ${rightBg}`}>
        {row.right !== null ? (
          <span className={`whitespace-pre block px-2 font-mono text-xs ${rightText}`}>{row.right}</span>
        ) : (
          <span className="block px-2">&nbsp;</span>
        )}
      </div>
    </div>
  );
}

function FileChangeView({ toolName, arguments: args, metadata }: Props) {
  if (toolName === 'write_file') {
    const content = String(args.content ?? '');
    if (!content) return null;

    const lines = splitContent(content);
    const lineNumWidth = String(lines.length).length;

    return (
      <div className="border-t border-zinc-700/50">
        <div className="overflow-auto max-h-64 font-mono text-xs leading-relaxed">
          {lines.map((line, i) => (
            <div key={i} className="flex hover:bg-zinc-800/50">
              <span
                className="flex-shrink-0 text-right text-zinc-600 select-none px-2 border-r border-zinc-700/50"
                style={{ minWidth: `${lineNumWidth + 1.5}ch` }}
              >
                {i + 1}
              </span>
              <span className="text-zinc-300 whitespace-pre px-2">{line}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // edit_file
  const oldContent = String(args.old_content ?? '');
  const newContent = String(args.new_content ?? '');
  const replaceAll = args.replace_all === true;
  const fileContent = metadata?.file_content ? String(metadata.file_content) : '';
  const linePosition = metadata?.line_position ? Number(metadata.line_position) : 0;
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (linePosition > 0 && containerRef.current) {
      const el = containerRef.current.querySelector(`[data-line="${linePosition}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center' });
      }
    }
  }, [linePosition]);

  // Full file view with inline diff
  if (fileContent) {
    const diffRows = buildDiffRows(oldContent, newContent);
    const allFileLines = splitContent(fileContent);
    const editLine0 = newContent
      ? findLineIdx(fileContent, newContent)
      : Math.max(0, linePosition - 1);
    const newLineCount = splitContent(newContent).length;
    const preLines = allFileLines.slice(0, editLine0);
    const postLines = allFileLines.slice(editLine0 + newLineCount);

    const preStartLine = linePosition > 0 ? linePosition - preLines.length : 1;
    const postStartLine = linePosition > 0 ? linePosition + newLineCount : editLine0 + newLineCount + 1;

    return (
      <div className="border-t border-zinc-700/50">
        {replaceAll && (
          <div className="px-3 py-1 text-[10px] text-amber-400 font-mono border-b border-zinc-700/50 bg-amber-950/20">
            替换全部
          </div>
        )}
        <div ref={containerRef} className="overflow-auto max-h-64 w-full text-xs leading-relaxed">
          {preLines.map((line, i) => (
            <div key={`pre-${i}`} data-line={preStartLine + i} className="flex hover:bg-zinc-800/30">
              <span className="flex-shrink-0 w-10 text-right pr-2 text-zinc-600 select-none border-r border-zinc-700/50 font-mono">
                {preStartLine + i}
              </span>
              <span className="text-zinc-400 whitespace-pre block px-2 font-mono">{line}</span>
            </div>
          ))}
          {preLines.length > 0 && <div className="border-t border-zinc-600/30 my-0.5" />}
          {diffRows.map((row, dIdx) => (
            <DiffRowView key={`diff-${dIdx}`} row={row} dataLine={linePosition + dIdx} />
          ))}
          {postLines.length > 0 && <div className="border-t border-zinc-600/30 my-0.5" />}
          {postLines.map((line, i) => (
            <div key={`post-${i}`} data-line={postStartLine + i} className="flex hover:bg-zinc-800/30">
              <span className="flex-shrink-0 w-10 text-right pr-2 text-zinc-600 select-none border-r border-zinc-700/50 font-mono">
                {postStartLine + i}
              </span>
              <span className="text-zinc-400 whitespace-pre block px-2 font-mono">{line}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Fallback: no file content, show diff-only view
  const rows = buildDiffRows(oldContent, newContent);
  if (rows.length === 0) return null;

  return (
    <div className="border-t border-zinc-700/50">
      {replaceAll && (
        <div className="px-3 py-1 text-[10px] text-amber-400 font-mono border-b border-zinc-700/50 bg-amber-950/20">
          替换全部 &mdash; <code className="text-amber-300">{oldContent.slice(0, 50)}{oldContent.length > 50 ? '...' : ''}</code>
          共 {oldContent.split('\n').filter(l => l).length} 行
        </div>
      )}
      <div className="overflow-auto max-h-64 w-full font-mono text-xs leading-relaxed">
        {rows.map((row, i) => (
          <DiffRowView key={i} row={row} />
        ))}
      </div>
    </div>
  );
}

export default memo(FileChangeView);
