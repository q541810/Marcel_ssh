import { describe, expect, it } from 'vitest';
import { getCommandPreview } from '@/components/agent/ToolCallCard';

describe('getCommandPreview', () => {
  it('shows a single http_get url', () => {
    expect(getCommandPreview('http_get', { url: 'https://example.com/a' })).toBe('https://example.com/a');
  });

  it('shows http_get urls array preview', () => {
    expect(getCommandPreview('http_get', {
      urls: ['https://example.com/a', 'https://example.org/b', 'https://example.net/c'],
    })).toBe('https://example.com/a +2 more');
  });
});
