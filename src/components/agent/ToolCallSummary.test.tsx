import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/lib/types';
import ToolCallSummary from './ToolCallSummary';

const tool = (toolName: string): AgentMessage => ({
  id: toolName, role: 'tool', content: '', timestamp: '',
  toolResult: { toolName, summary: '', result: '', success: true, blocked: false },
});

describe('compact tool summary', () => {
  it('renders unique names with ASCII commas and no count or spacing text', () => {
    const html = renderToStaticMarkup(<ToolCallSummary messages={[tool('bash'), tool('write'), tool('bash')]} />);
    expect(html).toContain('aria-label="执行bash,write"');
    expect(html.replace(/<[^>]*>/g, '')).toBe('执行bash,write');
    expect(html.match(/data-tool-summary-name=/g)).toHaveLength(2);
  });

  it('preserves full names for assistive technology and tooltips while allowing separate truncation', () => {
    const name = 'mcp.custom.very_long_tool_name_that_does_not_fit';
    const html = renderToStaticMarkup(<ToolCallSummary messages={[tool(name), tool('write')]} />);
    expect(html).toContain(`title="${name}"`);
    expect(html).toContain(`title="执行${name},write"`);
    expect(html).toContain('tool-call-summary-text');
    expect(html).toContain('tool-call-summary-name');
  });
});
