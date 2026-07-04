/**
 * Glob-style event pattern matching, shared by the IPC event fanout and the
 * content-script injection API.
 *
 * `prefix/*` matches any event whose name starts with `prefix/`; anything
 * else is an exact string match.
 */

export function matchPattern(pattern: string, event: string): boolean {
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1); // keep the /
    return event.startsWith(prefix);
  }
  return pattern === event;
}