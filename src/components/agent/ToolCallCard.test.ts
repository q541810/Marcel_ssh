import { describe, expect, it } from 'vitest';
import { getCommandPreview } from '@/components/agent/ToolCallCard';

describe('getCommandPreview', () => {
  it('shows a single web_search query', () => {
    expect(getCommandPreview('web_search', { query: '水月雨 Kadenz' })).toBe('水月雨 Kadenz');
  });

  it('does not preview deprecated web_search queries arrays', () => {
    expect(getCommandPreview('web_search', { queries: ['a', 'b'] })).toBe('');
  });

  it('shows a single http_get url', () => {
    expect(getCommandPreview('http_get', { url: 'https://example.com/a' })).toBe('https://example.com/a');
  });

  it('shows http_get urls array preview', () => {
    expect(getCommandPreview('http_get', {
      urls: ['https://example.com/a', 'https://example.org/b', 'https://example.net/c'],
    })).toBe('https://example.com/a +2 more');
  });

  it('shows subagent description preview', () => {
    expect(getCommandPreview('subagent', { description: 'explore nginx config' })).toBe(
      'explore nginx config',
    );
  });

  it('falls back to prompt when subagent has no description', () => {
    expect(getCommandPreview('subagent', { prompt: 'look at /etc/nginx/nginx.conf' })).toBe(
      'look at /etc/nginx/nginx.conf',
    );
  });

  it('truncates long subagent descriptions', () => {
    const long = 'a'.repeat(100);
    expect(getCommandPreview('subagent', { description: long })).toBe('a'.repeat(40) + '...');
  });

  it('returns empty preview for subagent without arguments', () => {
    expect(getCommandPreview('subagent', {})).toBe('');
  });

  it('still previews legacy task tool name (history compatibility)', () => {
    expect(getCommandPreview('task', { description: 'legacy' })).toBe('legacy');
  });
});
