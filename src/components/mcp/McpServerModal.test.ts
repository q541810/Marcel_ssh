import { describe, it, expect } from 'vitest';
import { parseMcpJson, headersToText, textToHeaders } from '@/components/mcp/McpServerModal';

describe('parseMcpJson', () => {
  it('parses standard mcpServers config', () => {
    const parsed = parseMcpJson(JSON.stringify({
      mcpServers: {
        'my-server': {
          url: 'https://mcp.example.com/sse',
          headers: { Authorization: 'Bearer abc123' },
        },
      },
    }));
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('my-server');
    expect(parsed!.url).toBe('https://mcp.example.com/sse');
    expect(parsed!.headers).toEqual({ Authorization: 'Bearer abc123' });
  });

  it('returns null for invalid JSON', () => {
    expect(parseMcpJson('not json')).toBeNull();
  });

  it('returns null when mcpServers is missing', () => {
    expect(parseMcpJson('{}')).toBeNull();
  });

  it('returns null when mcpServers is empty', () => {
    expect(parseMcpJson('{"mcpServers":{}}')).toBeNull();
  });

  it('returns null when first entry has no url', () => {
    expect(parseMcpJson('{"mcpServers":{"x":{}}}')).toBeNull();
  });

  it('returns null when url is empty string', () => {
    expect(parseMcpJson('{"mcpServers":{"x":{"url":""}}}')).toBeNull();
  });

  it('returns null when mcpServers is not an object', () => {
    expect(parseMcpJson('{"mcpServers":123}')).toBeNull();
  });

  it('handles entry without headers gracefully', () => {
    const parsed = parseMcpJson('{"mcpServers":{"bare":{"url":"https://x.com"}}}');
    expect(parsed).not.toBeNull();
    expect(parsed!.headers).toEqual({});
  });

  it('uses first key when multiple servers exist', () => {
    const parsed = parseMcpJson(JSON.stringify({
      mcpServers: {
        first: { url: 'https://first.com' },
        second: { url: 'https://second.com' },
      },
    }));
    expect(parsed!.name).toBe('first');
    expect(parsed!.url).toBe('https://first.com');
  });

  it('ignores non-string header values', () => {
    const parsed = parseMcpJson(JSON.stringify({
      mcpServers: {
        s: { url: 'https://x.com', headers: { auth: 'token', number: 42, bool: true } },
      },
    }));
    expect(parsed!.headers).toEqual({ auth: 'token' });
  });
});

describe('headersToText', () => {
  it('converts headers to key: value format', () => {
    const text = headersToText({ Authorization: 'Bearer x', 'X-Custom': 'val' });
    expect(text).toBe('Authorization: Bearer x\nX-Custom: val');
  });

  it('returns empty string for empty headers', () => {
    expect(headersToText({})).toBe('');
  });
});

describe('textToHeaders', () => {
  it('parses key: value lines', () => {
    const headers = textToHeaders('Authorization: Bearer token\nX-Custom: val');
    expect(headers).toEqual({ Authorization: 'Bearer token', 'X-Custom': 'val' });
  });

  it('skips empty lines', () => {
    const headers = textToHeaders('\n\nAuthorization: token\n');
    expect(headers).toEqual({ Authorization: 'token' });
  });

  it('preserves colons in header values', () => {
    const headers = textToHeaders('Authorization: Bearer abc:def:ghi');
    expect(headers).toEqual({ Authorization: 'Bearer abc:def:ghi' });
  });

  it('skips lines without colon', () => {
    const headers = textToHeaders('no colon here\nAuthorization: token');
    expect(headers).toEqual({ Authorization: 'token' });
  });

  it('trims whitespace', () => {
    const headers = textToHeaders('  Authorization  :  token  ');
    expect(headers).toEqual({ Authorization: 'token' });
  });

  it('skips empty key', () => {
    const headers = textToHeaders(': value');
    expect(headers).toEqual({});
  });

  it('returns empty object for empty input', () => {
    expect(textToHeaders('')).toEqual({});
  });
});
