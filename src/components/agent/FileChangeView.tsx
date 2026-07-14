import { memo, useRef, useEffect, useState, useMemo, useCallback } from 'react';
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

type HunkMeta = {
  startLine: number;
  before: string;
  after: string;
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

function parseHunks(metadata?: Record<string, unknown>): HunkMeta[] | null {
  const raw = metadata?.hunks;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const hunks: HunkMeta[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    hunks.push({
      startLine: Number(o.startLine ?? o.start_line ?? 1) || 1,
      before: String(o.before ?? ''),
      after: String(o.after ?? ''),
    });
  }
  return hunks.length > 0 ? hunks : null;
}

/** Indices of first row of each changed region in a full-file diff. */
function changedRegionStarts(rows: DiffRow[]): number[] {
  const starts: number[] = [];
  let inChange = false;
  for (let i = 0; i < rows.length; i++) {
    const changed = rows[i].type !== 'unchanged';
    if (changed && !inChange) {
      starts.push(i);
      inChange = true;
    } else if (!changed) {
      inChange = false;
    }
  }
  return starts;
}

function DiffRowView({
  row,
  dataLine,
  dataMatch,
}: {
  row: DiffRow;
  dataLine?: number;
  dataMatch?: number;
}) {
  const isChanged = row.type !== 'unchanged';
  const leftHasContent = row.left !== null;
  const rightHasContent = row.right !== null;

  const leftBg = isChanged && leftHasContent ? 'bg-red-950/30' : '';
  const rightBg = isChanged && rightHasContent ? 'bg-emerald-950/40' : '';
  const leftText = isChanged && leftHasContent ? 'text-red-300' : 'text-zinc-400';
  const rightText = isChanged && rightHasContent ? 'text-emerald-200' : 'text-zinc-300';

  let marker: string;
  if (row.left !== null && row.right !== null) marker = '~';
  else if (row.left !== null) marker = '-';
  else marker = '+';

  return (
    <div className="flex min-w-max" data-line={dataLine} data-match={dataMatch}>
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

function MatchNavBar({
  count,
  activeIndex,
  labels,
  onGo,
}: {
  count: number;
  activeIndex: number;
  labels?: string[];
  onGo: (index: number) => void;
}) {
  if (count <= 1) return null;
  const showPills = count <= 8;
  const label = labels?.[activeIndex];

  return (
    <div className="flex items-center gap-2 px-3 py-1 border-b border-zinc-700/50 bg-zinc-900/80">
      <button
        type="button"
        disabled={activeIndex <= 0}
        onClick={() => onGo(activeIndex - 1)}
        className="px-1.5 py-0.5 rounded text-[11px] text-zinc-300 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label="上一处"
      >
        ‹
      </button>
      <span className="text-[11px] font-mono text-zinc-400 tabular-nums min-w-[4.5rem] text-center">
        {activeIndex + 1} / {count}
        {label ? ` · ${label}` : ''}
      </span>
      <button
        type="button"
        disabled={activeIndex >= count - 1}
        onClick={() => onGo(activeIndex + 1)}
        className="px-1.5 py-0.5 rounded text-[11px] text-zinc-300 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label="下一处"
      >
        ›
      </button>
      {showPills && (
        <div className="flex items-center gap-1 ml-1 flex-wrap">
          {Array.from({ length: count }, (_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onGo(i)}
              className={`min-w-[1.25rem] h-5 px-1 rounded text-[10px] font-mono transition-colors ${
                i === activeIndex
                  ? 'bg-indigo-600 text-white'
                  : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
              }`}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}
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
  const occurrences = metadata?.occurrences != null ? Number(metadata.occurrences) : 0;
  const matchLines = Array.isArray(metadata?.match_line_positions)
    ? (metadata.match_line_positions as unknown[]).map((n) => Number(n)).filter((n) => n > 0)
    : [];
  const before = metadata?.before != null ? String(metadata.before) : '';
  const after = metadata?.after != null ? String(metadata.after) : '';
  const hunks = parseHunks(metadata);
  const fileContent = metadata?.file_content ? String(metadata.file_content) : '';
  const linePosition = metadata?.line_position ? Number(metadata.line_position) : 0;

  const containerRef = useRef<HTMLDivElement>(null);
  const [activeMatch, setActiveMatch] = useState(0);

  const fullDiffRows = useMemo(() => {
    if (before || after) return buildDiffRows(before, after);
    return null;
  }, [before, after]);

  const regionStarts = useMemo(
    () => (fullDiffRows ? changedRegionStarts(fullDiffRows) : []),
    [fullDiffRows],
  );

  const matchCount = useMemo(() => {
    if (hunks) return hunks.length;
    if (regionStarts.length > 0) return regionStarts.length;
    if (matchLines.length > 1) return matchLines.length;
    if (occurrences > 1) return occurrences;
    return 1;
  }, [hunks, regionStarts.length, matchLines.length, occurrences]);

  const navLabels = useMemo(() => {
    if (hunks) return hunks.map((h) => `L${h.startLine}`);
    if (matchLines.length > 0) return matchLines.map((l) => `L${l}`);
    return undefined;
  }, [hunks, matchLines]);

  const scrollToMatch = useCallback(
    (index: number) => {
      const maxIdx = Math.max(0, matchCount - 1);
      const clamped = Math.max(0, Math.min(index, maxIdx));
      setActiveMatch(clamped);
      const root = containerRef.current;
      if (!root) return;
      let el: Element | null =
        root.querySelector(`[data-match="${clamped}"]`) ??
        root.querySelector(`[data-hunk="${clamped}"]`) ??
        (clamped === 0
          ? root.querySelector('[data-match]') ?? root.querySelector('[data-hunk]')
          : null);
      // Legacy / single-edit: jump by line_position when no match anchors.
      if (!el && linePosition > 0) {
        el = root.querySelector(`[data-line="${linePosition}"]`);
      }
      if (!el) return;
      // Scroll inside overflow container (scrollIntoView can scroll the page).
      const parentRect = root.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const delta =
        elRect.top - parentRect.top - root.clientHeight / 2 + elRect.height / 2;
      root.scrollTo({ top: Math.max(0, root.scrollTop + delta), behavior: 'smooth' });
    },
    [matchCount, linePosition],
  );

  useEffect(() => {
    setActiveMatch(0);
  }, [before, after, hunks?.length, fileContent, linePosition]);

  // Always jump to first change (single or multi) after layout.
  useEffect(() => {
    if (!before && !after && !hunks?.length && !fileContent) return;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      scrollToMatch(0);
    };
    // Double rAF: wait until DiffRowView with data-match is painted.
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(run);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [before, after, hunks?.length, fileContent, linePosition, scrollToMatch]);

  const bannerText =
    replaceAll || occurrences > 1
      ? `替换全部 · ${occurrences > 0 ? occurrences : matchCount} 处`
      : null;

  // ── Full before/after diff ──
  if (fullDiffRows && fullDiffRows.length > 0) {
    let leftLine = 1;
    let rightLine = 1;
    const matchStartSet = new Set(regionStarts);

    return (
      <div className="border-t border-zinc-700/50">
        {bannerText && (
          <div className="px-3 py-1 text-[10px] text-amber-400 font-mono border-b border-zinc-700/50 bg-amber-950/20">
            {bannerText}
          </div>
        )}
        <MatchNavBar
          count={matchCount}
          activeIndex={activeMatch}
          labels={navLabels}
          onGo={scrollToMatch}
        />
        <div ref={containerRef} className="overflow-auto max-h-64 w-full text-xs leading-relaxed">
          {fullDiffRows.map((row, i) => {
            const matchIdx = matchStartSet.has(i) ? regionStarts.indexOf(i) : undefined;
            const dataLine = row.left !== null ? leftLine : rightLine;
            if (row.left !== null) leftLine += 1;
            if (row.right !== null) rightLine += 1;
            return (
              <DiffRowView
                key={i}
                row={row}
                dataLine={dataLine}
                dataMatch={matchIdx !== undefined && matchIdx >= 0 ? matchIdx : undefined}
              />
            );
          })}
        </div>
      </div>
    );
  }

  // ── Hunk list (large files) ──
  if (hunks && hunks.length > 0) {
    return (
      <div className="border-t border-zinc-700/50">
        {bannerText && (
          <div className="px-3 py-1 text-[10px] text-amber-400 font-mono border-b border-zinc-700/50 bg-amber-950/20">
            {bannerText}
          </div>
        )}
        <MatchNavBar
          count={hunks.length}
          activeIndex={activeMatch}
          labels={navLabels}
          onGo={scrollToMatch}
        />
        <div ref={containerRef} className="overflow-auto max-h-64 w-full text-xs leading-relaxed">
          {hunks.map((hunk, hi) => {
            const rows = buildDiffRows(hunk.before, hunk.after);
            return (
              <div
                key={hi}
                data-hunk={hi}
                data-match={hi}
                className={hi > 0 ? 'border-t border-zinc-600/40 mt-1 pt-1' : ''}
              >
                <div className="px-2 py-0.5 text-[10px] font-mono text-zinc-500">
                  第 {hi + 1}/{hunks.length} 处 · L{hunk.startLine}
                </div>
                {rows.map((row, ri) => (
                  <DiffRowView key={ri} row={row} dataLine={hunk.startLine + ri} />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Legacy: file_content + single old/new patch ──
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
            {occurrences > 1 ? ` · ${occurrences} 处` : ''}
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
            <DiffRowView key={`diff-${dIdx}`} row={row} dataLine={linePosition + dIdx} dataMatch={dIdx === 0 ? 0 : undefined} />
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
          替换全部 &mdash;{' '}
          <code className="text-amber-300">
            {oldContent.slice(0, 50)}
            {oldContent.length > 50 ? '...' : ''}
          </code>
          共 {oldContent.split('\n').filter((l) => l).length} 行
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
