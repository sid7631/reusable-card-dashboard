import { createContext } from 'react';
import { getToken, signOut } from './auth';
import type { AppliedFilters, CardData } from './types';

export type RenderResult = CardData & { as_of: number; stale: boolean; cached: boolean };

interface Pending {
  itemId: string;
  filters: AppliedFilters;
  resolve: (r: RenderResult) => void;
  reject: (e: Error) => void;
}

/**
 * Batches card loads on one dashboard into a single streamed request: every card that asks within
 * the same short window is sent together to POST /render, and each promise resolves as its
 * server-sent event arrives — cached cards immediately, the rest as workers finish.
 */
export function createRenderBatcher(dashboardId: number, windowMs = 25) {
  let queue: Pending[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    const batch = queue;
    queue = [];
    timer = null;
    const waiting = new Map<string, Pending[]>();
    for (const p of batch) waiting.set(p.itemId, [...(waiting.get(p.itemId) ?? []), p]);
    // One entry per item: the latest filters win if a card asked twice in the window
    const items = [...waiting.values()].map((ps) => {
      const f = ps[ps.length - 1].filters;
      return { item_id: ps[0].itemId, filters: f.dims, date_from: f.from ?? null, date_to: f.to ?? null };
    });
    const fail = (e: Error) => batch.forEach((p) => p.reject(e));

    try {
      const token = getToken();
      const res = await fetch(`/api/dashboards/${dashboardId}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ items }),
      });
      if (res.status === 401) {
        signOut();
        window.location.assign('/login');
        return;
      }
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(typeof body.detail === 'string' ? body.detail : `Render failed (${res.status})`);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event !== 'card' || !data) continue;
          const msg = JSON.parse(data);
          for (const p of waiting.get(msg.item_id) ?? []) {
            if (msg.error) p.reject(new Error(msg.error));
            else p.resolve(msg as RenderResult);
          }
          waiting.delete(msg.item_id);
        }
      }
      // Anything the stream didn't answer
      for (const ps of waiting.values()) ps.forEach((p) => p.reject(new Error('No result returned.')));
    } catch (e) {
      fail(e as Error);
    }
  };

  return {
    load(itemId: string, filters: AppliedFilters): Promise<RenderResult> {
      return new Promise((resolve, reject) => {
        queue.push({ itemId, filters, resolve, reject });
        timer ??= setTimeout(flush, windowMs);
      });
    },
  };
}

export type RenderBatcher = ReturnType<typeof createRenderBatcher>;
export const RenderContext = createContext<RenderBatcher | null>(null);
