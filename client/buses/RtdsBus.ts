/**
 * Shared browser-side RTDS bus with Kraken failover.
 *
 * ONE WebSocket per tab to wss://ws-live-data.polymarket.com, fanned out to
 * every consumer. Extracted from TripleUCrypt/ui/shared/rtds_bus.py RTDS_BUS_JS.
 *
 * API: sub(cb) => unsub — cb receives an array of message objects.
 * The bus is a singleton on window.__tcRTDS; this module wires it up and exports
 * a typed `sub` helper.
 */

// Inject the bus singleton exactly once (idempotent, SSR-safe).
if (typeof window !== 'undefined') {
  // @ts-ignore — global singleton
  window.__tcGetRTDS = window.__tcGetRTDS || function () {
    // @ts-ignore
    if (window.__tcRTDS) return window.__tcRTDS;
    const subs = new Set<(arr: unknown[]) => void>();
    function fan(arr: unknown[]) { for (const cb of subs) { try { cb(arr); } catch (e) {} } }

    // ── primary: Polymarket RTDS ────────────────────────────────────────────
    let ws: WebSocket | null = null, backoff = 2000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    let lastMsg = 0, connAt = 0;
    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 120000);
      krakenStart();
    }
    function connect() {
      try { ws = new WebSocket('wss://ws-live-data.polymarket.com'); }
      catch (e) { schedule(); return; }
      connAt = Date.now();
      ws.onopen = () => {
        backoff = 2000;
        lastMsg = Date.now();
        krakenStop();
        try {
          ws!.send(JSON.stringify({ action: 'subscribe', subscriptions: [
            { topic: 'crypto_prices_chainlink', type: '*' },
            { topic: 'activity', type: 'trades' },
            { topic: 'comments', type: '*' },
          ] }));
        } catch (e) {}
        if (ping) clearInterval(ping);
        ping = setInterval(() => { try { ws!.send('PING'); } catch (e) {} }, 5000);
      };
      ws.onmessage = (ev) => {
        lastMsg = Date.now();
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        fan(Array.isArray(m) ? m : [m]);
      };
      ws.onclose = () => { if (ping) clearInterval(ping); schedule(); };
      ws.onerror = () => { try { ws!.close(); } catch (e) {} };
    }

    // ── failover: Kraken public ticker → RTDS-shaped price frames ──────────
    let kws: WebSocket | null = null;
    let ktimer: ReturnType<typeof setTimeout> | null = null;
    let kactive = false, kLastMsg = 0, kConnAt = 0;
    function krakenStart() {
      if (kactive) return;
      kactive = true;
      krakenConnect();
    }
    function krakenStop() {
      kactive = false;
      if (ktimer) clearTimeout(ktimer);
      if (kws) { kws.onclose = null; try { kws.close(); } catch (e) {} kws = null; }
    }
    function krakenConnect() {
      if (!kactive) return;
      try { kws = new WebSocket('wss://ws.kraken.com/v2'); }
      catch (e) { ktimer = setTimeout(krakenConnect, 5000); return; }
      kConnAt = Date.now();
      kws.onopen = () => {
        kLastMsg = Date.now();
        try {
          kws!.send(JSON.stringify({ method: 'subscribe', params: { channel: 'ticker',
            symbol: ['BTC/USD','ETH/USD','SOL/USD','XRP/USD','DOGE/USD','HYPE/USD','BNB/USD'] } }));
        } catch (e) {}
      };
      kws.onmessage = (ev) => {
        kLastMsg = Date.now();
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m && m.channel === 'ticker' && Array.isArray(m.data)) {
          fan(m.data.map((t: {symbol: string; last: number}) => ({
            topic: 'crypto_prices_chainlink',
            payload: { symbol: t.symbol, value: t.last, source: 'kraken' }
          })));
        }
      };
      kws.onclose = () => { if (kactive) ktimer = setTimeout(krakenConnect, 5000); };
      kws.onerror = () => { try { kws!.close(); } catch (e) {} };
    }

    // Zombie watchdog
    setInterval(() => {
      const now = Date.now();
      if (ws && ws.readyState === 0 && connAt && (now - connAt) > 20000) {
        try { ws.onclose = null; ws.close(); } catch (e) {}
        ws = null; if (ping) clearInterval(ping); schedule();
      } else if (!kactive && ws && ws.readyState === 1 && lastMsg && (now - lastMsg) > 15000) {
        try { ws.onclose = null; ws.close(); } catch (e) {}
        if (ping) clearInterval(ping); schedule();
      }
      if (kactive && kws) {
        if (kws.readyState === 0 && kConnAt && (now - kConnAt) > 20000) {
          try { kws.onclose = null; kws.close(); } catch (e) {}
          kws = null; if (ktimer) clearTimeout(ktimer); ktimer = setTimeout(krakenConnect, 5000);
        } else if (kws.readyState === 1 && kLastMsg && (now - kLastMsg) > 15000) {
          try { kws.onclose = null; kws.close(); } catch (e) {}
          kws = null; krakenConnect();
        }
      }
    }, 5000);

    connect();
    // @ts-ignore
    window.__tcRTDS = { sub(cb: (arr: unknown[]) => void) { subs.add(cb); return () => subs.delete(cb); } };
    // @ts-ignore
    return window.__tcRTDS;
  };
}

/** Subscribe to the RTDS bus. Returns an unsubscribe function. */
export function sub(cb: (arr: unknown[]) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  // @ts-ignore
  return window.__tcGetRTDS().sub(cb);
}
