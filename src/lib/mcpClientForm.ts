interface ParsedMcpEntry {
  name: string;
  url: string;
  headers: Record<string, string>;
}

export function parseMcpJson(text: string): ParsedMcpEntry | null {
  try {
    const obj = JSON.parse(text);
    const servers = obj.mcpServers;
    if (!servers || typeof servers !== 'object') return null;
    const keys = Object.keys(servers);
    if (keys.length === 0) return null;
    const key = keys[0];
    const entry = servers[key];
    if (!entry || typeof entry.url !== 'string' || !entry.url.trim()) return null;
    const headers: Record<string, string> = {};
    if (entry.headers && typeof entry.headers === 'object') {
      for (const [k, v] of Object.entries(entry.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
    }
    return { name: key, url: entry.url.trim(), headers };
  } catch {
    return null;
  }
}

export function headersToText(h: Record<string, string>): string {
  return Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n');
}

export function textToHeaders(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    if (key) result[key] = match[2];
  }
  return result;
}
