/**
 * Shared browser-side CLOB market bus.
 *
 * ONE WebSocket per tab to wss://ws-subscriptions-clob.polymarket.com/ws/market.
 * Extracted from TripleUCrypt/ui/shared/clob_bus.py CLOB_BUS_JS.
 *
 * API: sub(tokens, cb) => unsub  — cb receives (token, ask¢, bid¢|null)
 */

type ClobCb = (token: string, ask: number, bid: number | null) => void;

if (typeof window !== 'undefined') {
  // @ts-ignore — global singleton
  window.__tcGetCLOB = window.__tcGetCLOB || function () {
    // @ts-ignore
    if (window.__tcCLOB) return window.__tcCLOB;
    const subs = new Map<ClobCb, Set<string>>();
    let wanted: string[] = [];
    let ws: WebSocket | null = null, sentKey = '', backoff = 1000;
    let reconnectT: ReturnType<typeof setTimeout> | null = null;
    let debounceT: ReturnType<typeof setTimeout> | null = null;
    let lastMsg = 0;
    let ping: ReturnType<typeof setInterval> | null = null;

    function recompute() {
      const s = new Set<string>();
      for (const set of subs.values()) for (const t of set) if (t) s.add(t);
      wanted = [...s].sort();
    }
    const lastBook = new Map<string, {ask: number|null; bid: number|null}>();
    function fanToken(token: string, ask: number, bid: number|null) {
      if (token == null || ask == null || isNaN(ask)) return;
      for (const [cb, set] of subs) { if (set.has(token)) { try { cb(token, ask, bid); } catch (e) {} } }
    }
    function upd(token: string, ask: number|null, bid: number|null) {
      if (token == null) return;
      const c = lastBook.get(token) || { ask: null, bid: null };
      if (ask != null && !isNaN(ask)) c.ask = ask;
      if (bid != null && !isNaN(bid)) c.bid = bid;
      lastBook.set(token, c);
      if (c.ask != null) fanToken(token, c.ask, c.bid);
    }
    function handle(msg: unknown) {
      const book = (item: Record<string, unknown>) => {
        if (!item || !item['asset_id']) return;
        let bestA: number|null = null, bestB: number|null = null;
        if (Array.isArray(item['asks'])) for (const lvl of item['asks'] as {price: string}[]) { const p = parseFloat(lvl.price); if (!isNaN(p) && (bestA === null || p < bestA)) bestA = p; }
        if (Array.isArray(item['bids'])) for (const lvl of item['bids'] as {price: string}[]) { const p = parseFloat(lvl.price); if (!isNaN(p) && (bestB === null || p > bestB)) bestB = p; }
        if (bestA !== null || bestB !== null)
          upd(item['asset_id'] as string, bestA !== null ? bestA * 100 : null, bestB !== null ? bestB * 100 : null);
      };
      if (Array.isArray(msg)) { for (const it of msg) book(it as Record<string, unknown>); }
      else if (msg && typeof msg === 'object' && Array.isArray((msg as Record<string, unknown>)['price_changes'])) {
        for (const pc of (msg as {price_changes: {asset_id: string; best_ask?: string; best_bid?: string}[]}).price_changes) {
          if (pc.asset_id == null) continue;
          const a = pc.best_ask != null ? parseFloat(pc.best_ask) : NaN;
          const b = pc.best_bid != null ? parseFloat(pc.best_bid) : NaN;
          upd(pc.asset_id, isNaN(a) ? null : a * 100, isNaN(b) ? null : b * 100);
        }
      } else if (msg && typeof msg === 'object' && (msg as Record<string, unknown>)['asset_id']) {
        book(msg as Record<string, unknown>);
      }
    }
    function scheduleReconnect() {
      if (reconnectT) clearTimeout(reconnectT);
      reconnectT = setTimeout(() => { sentKey = ''; open(); }, backoff);
      backoff = Math.min(backoff * 2, 8000);
    }
    function open() {
      if (reconnectT) clearTimeout(reconnectT);
      if (ping) clearInterval(ping);
      if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} ws = null; }
      lastBook.clear();
      if (!wanted.length) { sentKey = ''; return; }
      const key = wanted.join(',');
      sentKey = key;
      let sock: WebSocket;
      try { sock = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market'); }
      catch (e) { scheduleReconnect(); return; }
      ws = sock;
      lastMsg = Date.now();
      sock.onopen = () => {
        backoff = 1000; lastMsg = Date.now();
        try { sock.send(JSON.stringify({ assets_ids: wanted, type: 'market' })); } catch (e) {}
        if (ping) clearInterval(ping);
        ping = setInterval(() => { try { sock.send('PING'); } catch (e) {} }, 10000);
      };
      sock.onmessage = (ev) => { lastMsg = Date.now(); let m; try { m = JSON.parse(ev.data); } catch (e) { return; } handle(m); };
      sock.onclose = () => { if (ws === sock) { ws = null; if (ping) clearInterval(ping); scheduleReconnect(); } };
      sock.onerror = () => { try { sock.close(); } catch (e) {} };
    }
    setInterval(() => {
      if (!wanted.length || !ws || ws.readyState !== 1) return;
      if (lastMsg && (Date.now() - lastMsg) > 30000) {
        try { ws.onclose = null; ws.close(); } catch (e) {}
        ws = null; if (ping) clearInterval(ping); scheduleReconnect();
      }
    }, 5000);
    function sync() {
      const key = wanted.join(',');
      if (key === sentKey && ws && ws.readyState <= 1) return;
      open();
    }
    function scheduleSync() { if (debounceT) clearTimeout(debounceT); debounceT = setTimeout(sync, 200); }

    // @ts-ignore
    window.__tcCLOB = {
      sub(tokens: string[], cb: ClobCb) {
        subs.set(cb, new Set((tokens || []).filter(Boolean)));
        recompute(); scheduleSync();
        return () => { subs.delete(cb); recompute(); scheduleSync(); };
      },
    };
    // @ts-ignore
    return window.__tcCLOB;
  };
}

/** Subscribe to the CLOB bus for a set of token IDs. */
export function sub(tokens: string[], cb: (token: string, ask: number, bid: number | null) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  // @ts-ignore
  return window.__tcGetCLOB().sub(tokens, cb);
}
