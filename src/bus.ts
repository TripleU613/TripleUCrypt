/**
 * Internal event bus — typed Node.js EventEmitter singleton.
 * All cross-module communication goes through this bus.
 */
import { EventEmitter } from "node:events";

// ── Event payload types ───────────────────────────────────────────────────────

interface BusEvents {
  /** A state key changed. */
  patch: [key: string, value: unknown];
  /** CLOB price tick for a token. */
  price_buf: [tokenId: string, isUp: boolean, ask: number, bid: number];
  /** CLOB full order-book snapshot for a token. */
  book_buf: [tokenId: string, bids: [number, number][], asks: [number, number][]];
  /** Kraken WebSocket ticker tick. */
  kraken_tick: [asset: string, price: number, change24h: number];
  /** Chainlink oracle price via RTDS feed. */
  chainlink_tick: [asset: string, price: number];
  /** RTDS activity trade event. */
  rtds_trade: [data: Record<string, unknown>];
  /** Theme changed (dark/light). */
  theme_change: [theme: string];
  /** Sitewide toast notification (log=green, warn=orange, error=red). */
  notify: [payload: { id: number; level: "log" | "warn" | "error"; text: string }];
}

// ── Typed EventEmitter wrapper ────────────────────────────────────────────────

class TypedBus extends EventEmitter {
  emit<K extends keyof BusEvents>(event: K, ...args: BusEvents[K]): boolean {
    return super.emit(event as string, ...args);
  }

  on<K extends keyof BusEvents>(
    event: K,
    listener: (...args: BusEvents[K]) => void,
  ): this {
    return super.on(event as string, listener as (...args: unknown[]) => void);
  }

  once<K extends keyof BusEvents>(
    event: K,
    listener: (...args: BusEvents[K]) => void,
  ): this {
    return super.once(event as string, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof BusEvents>(
    event: K,
    listener: (...args: BusEvents[K]) => void,
  ): this {
    return super.off(event as string, listener as (...args: unknown[]) => void);
  }
}

/** Singleton event bus. Import this and use `bus.emit(...)` / `bus.on(...)`. */
export const bus = new TypedBus();
bus.setMaxListeners(50);
