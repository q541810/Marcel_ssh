// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  MessageViewCacheContext, MessageViewIdContext, useMessageViewState, type MessageViewCache,
} from './messageViewState';

function Row() {
  const [open, setOpen] = useMessageViewState('expanded', false);
  return <button onClick={() => setOpen((previous) => !previous)}>{open ? 'open' : 'closed'}</button>;
}
let root: Root;
let host: HTMLDivElement;
let cache: MessageViewCache;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  cache = new Map();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(id: string | null, owner = cache) {
  await act(async () => root.render(
    <MessageViewCacheContext.Provider value={owner}>
      {id && <MessageViewIdContext.Provider key={id} value={id}><Row /></MessageViewIdContext.Provider>}
    </MessageViewCacheContext.Provider>,
  ));
}
it('restores only that message state after virtual unmounts, with functional updates', async () => {
  await render('a');
  await act(async () => host.querySelector('button')!.click());
  await render(null);
  await render('b');
  expect(host.textContent).toBe('closed');
  await render('a');
  expect(host.textContent).toBe('open');
  await act(async () => host.querySelector('button')!.click());
  expect(cache.get('a')?.get('expanded')).toBe(false);
});
it('isolates identical message ids in independent live/history lists', async () => {
  await render('a');
  await act(async () => host.querySelector('button')!.click());
  await render(null);
  await render('a', new Map());
  expect(host.textContent).toBe('closed');
  expect(cache.get('a')?.get('expanded')).toBe(true);
});
it('falls back to ordinary component state outside a list', async () => {
  await act(async () => root.render(<Row />));
  await act(async () => host.querySelector('button')!.click());
  expect(host.textContent).toBe('open');
  expect(cache.size).toBe(0);
});
