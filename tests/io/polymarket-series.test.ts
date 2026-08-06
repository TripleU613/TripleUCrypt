/**
 * Tests for the SERIES discovery path in src/io/polymarket.ts — the 1h/1d
 * windows, whose per-window slugs are human-readable ET dates and so are found
 * via /series?slug → /events?series_id instead of being constructed.
 *
 * undici is mocked so a fake Gamma answers by path; the assertions are about the
 * normalised MarketWindow shape the engine consumes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Fake Gamma / CLOB ─────────────────────────────────────────────────────────

/** path → JSON body. Anything unmatched answers 404. */
let routes: Array<[RegExp, unknown]> = [];
const seen: string[] = [];

vi.mock("undici", () => {
  class FakePool {
    constructor(public origin: string) {}
    async request({ path }: { path: string }) {
      seen.push(path);
      const hit = routes.find(([re]) => re.test(path));
      return {
        statusCode: hit ? 200 : 404,
        body: {
          text: async () => JSON.stringify(hit ? hit[1] : null),
          dump: async () => undefined,
        },
      };
    }
  }
  return { Pool: FakePool };
});

const pm = await import("../../src/io/polymarket.js");

const HOUR = 3600;
const nowSec = () => Math.trunc(Date.now() / 1000);
const iso = (ts: number) => new Date(ts * 1000).toISOString();

/** One /events row shaped like the real thing (event wrapping one market). */
function event(slug: string, endTs: number, opts: Record<string, unknown> = {}) {
  return {
    slug,
    markets: [{
      slug,
      active: true,
      closed: false,
      endDate: iso(endTs),
      eventStartTime: iso(endTs - HOUR),
      question: "Bitcoin Up or Down - August 6, 12PM ET",
      conditionId: `0xcond-${slug}`,
      clobTokenIds: JSON.stringify([`up-${slug}`, `dn-${slug}`]),
      ...opts,
    }],
  };
}

beforeEach(() => {
  routes = [];
  seen.length = 0;
  pm._clearSeriesCaches();
});

// ── Slug helpers ──────────────────────────────────────────────────────────────

describe("series slugs", () => {
  it("builds <asset>-up-or-down-<recurrence>", () => {
    expect(pm.seriesSlugFor("BTC", "1h")).toBe("btc-up-or-down-hourly");
    expect(pm.seriesSlugFor("DOGE", "1d")).toBe("doge-up-or-down-daily");
  });

  it("covers 7 assets × {1h, 1d} — coverage gaps are decided by the lookup, not a list", () => {
    expect(pm.SERIES_SLUGS).toHaveLength(14);
    expect(new Set(pm.SERIES_SLUGS.map(s => s.asset)).size).toBe(7);
    expect(new Set(pm.SERIES_SLUGS.map(s => s.interval))).toEqual(new Set(["1h", "1d"]));
  });

  it("recognises a series slug (and not a per-window one)", () => {
    expect(pm.isSeriesSlug("btc-up-or-down-hourly")).toBe(true);
    expect(pm.isSeriesSlug("btc-up-or-down-daily")).toBe(true);
    expect(pm.isSeriesSlug("btc-updown-5m")).toBe(false);
    expect(pm.isSeriesSlug("bitcoin-up-or-down-august-6-2026-11am-et")).toBe(false);
  });
});

// ── pickLiveSeriesMarket ──────────────────────────────────────────────────────

describe("pickLiveSeriesMarket", () => {
  const now = 1_800_000_000;

  it("takes the earliest window that still ends in the future", () => {
    const evs = [
      event("third", now + 3 * HOUR),
      event("next",  now + 1 * HOUR),
      event("later", now + 2 * HOUR),
    ];
    expect(pm.pickLiveSeriesMarket(evs, now)?.slug).toBe("next");
  });

  it("ignores stale events, which /events?closed=false still returns", () => {
    // Verified against the live API: a May window shows up in an August query
    // with closed=false and active=true, but its endDate is months in the past.
    const evs = [event("may", now - 90 * 86400), event("live", now + HOUR)];
    expect(pm.pickLiveSeriesMarket(evs, now)?.slug).toBe("live");
  });

  it("ignores resolved/inactive markets and ones with no token pair", () => {
    expect(pm.pickLiveSeriesMarket([event("a", now + 60, { closed: true })], now)).toBeNull();
    expect(pm.pickLiveSeriesMarket([event("b", now + 60, { active: false })], now)).toBeNull();
    expect(pm.pickLiveSeriesMarket([event("c", now + 60, { clobTokenIds: "[\"only-one\"]" })], now)).toBeNull();
  });

  it("returns null for an empty series", () => {
    expect(pm.pickLiveSeriesMarket([], now)).toBeNull();
    expect(pm.pickLiveSeriesMarket([{ slug: "x" }], now)).toBeNull();
  });
});

// ── Discovery / normalisation ─────────────────────────────────────────────────

describe("fetchAllWindows — series path", () => {
  it("normalises 1h/1d windows into the same shape the engine already consumes", async () => {
    const end = nowSec() + 600;
    routes = [
      [/^\/markets\?slug=/, []],                                  // no 5m/15m windows
      [/^\/series\?slug=btc-up-or-down-hourly/, [{ id: "10114" }]],
      [/^\/series\?slug=btc-up-or-down-daily/,  [{ id: "41" }]],
      [/^\/series\?slug=/, []],                                   // every other asset: none
      [/^\/events\?series_id=10114/, [event("bitcoin-up-or-down-august-6-2026-12pm-et", end)]],
      [/^\/events\?series_id=41/,    [event("bitcoin-up-or-down-on-august-7-2026", end + 86400)]],
    ];

    const wins = await pm.fetchAllWindows(false);

    // 5m/15m keep their placeholder-per-slug contract; series windows are extra.
    expect(wins.slice(0, 14).map(w => w.slug)).toEqual(pm.MARKET_SLUGS.map(s => s.baseSlug));
    const extra = wins.slice(14);
    expect(extra.map(w => `${w.asset}:${w.interval}`)).toEqual(["BTC:1h", "BTC:1d"]);

    const hourly = extra[0];
    expect(hourly).toMatchObject({
      asset:          "BTC",
      interval:       "1h",
      slug:           "btc-up-or-down-hourly",   // stable identity across rollovers
      up_token:       "up-bitcoin-up-or-down-august-6-2026-12pm-et",
      dn_token:       "dn-bitcoin-up-or-down-august-6-2026-12pm-et",
      condition_id:   "0xcond-bitcoin-up-or-down-august-6-2026-12pm-et",
      series_id:      "10114",                   // from the series we asked for
      end_ts:         end,
      event_start_ts: end - HOUR,
      current_price:  0,
      strike:         "—",                       // hourly questions carry no $ strike
    });
    expect(hourly.secs_left).toBeGreaterThan(0);
    expect(hourly.question).toContain("Bitcoin Up or Down");
  });

  it("renders no card for an asset with no series (SOL has neither hourly nor daily)", async () => {
    routes = [
      [/^\/markets\?slug=/, []],
      [/^\/series\?slug=/, []],       // nothing resolves
    ];
    const wins = await pm.fetchAllWindows(false);
    expect(wins).toHaveLength(14);                     // only the 5m/15m placeholders
    expect(wins.some(w => w.interval === "1h" || w.interval === "1d")).toBe(false);
  });

  it("renders no card when the series exists but has no live window", async () => {
    routes = [
      [/^\/markets\?slug=/, []],
      [/^\/series\?slug=btc-up-or-down-hourly/, [{ id: "10114" }]],
      [/^\/series\?slug=/, []],
      [/^\/events\?series_id=10114/, [event("stale", nowSec() - 86400)]],
    ];
    const wins = await pm.fetchAllWindows(false);
    expect(wins.some(w => w.interval === "1h")).toBe(false);
  });

  it("resolves each series id once and reuses it across polls", async () => {
    routes = [
      [/^\/markets\?slug=/, []],
      [/^\/series\?slug=btc-up-or-down-hourly/, [{ id: "10114" }]],
      [/^\/series\?slug=/, []],
      [/^\/events\?series_id=10114/, [event("live", nowSec() + 600)]],
    ];
    await pm.fetchAllWindows(false);
    const first = seen.filter(p => p.startsWith("/series?slug=")).length;
    expect(first).toBe(pm.SERIES_SLUGS.length);

    seen.length = 0;
    await pm.fetchAllWindows(false);
    expect(seen.filter(p => p.startsWith("/series?slug="))).toHaveLength(0);
    expect(seen.some(p => p.startsWith("/events?series_id=10114"))).toBe(true);
  });

  it("holds the last live window when a poll's /events call fails, then drops it at its end", async () => {
    const end = nowSec() + 600;
    routes = [
      [/^\/markets\?slug=/, []],
      [/^\/series\?slug=btc-up-or-down-hourly/, [{ id: "10114" }]],
      [/^\/series\?slug=/, []],
      [/^\/events\?series_id=10114/, [event("live", end)]],
    ];
    expect((await pm.fetchAllWindows(false)).some(w => w.interval === "1h")).toBe(true);

    // Gamma throttles this poll (404 → null). The card must not blink out.
    routes = routes.filter(([re]) => !/events/.test(re.source));
    const held = (await pm.fetchAllWindows(false)).find(w => w.interval === "1h");
    expect(held?.end_ts).toBe(end);
    expect(held?.secs_left).toBeGreaterThan(0);

    // Once the held window's own end has passed, it is dropped rather than shown
    // as a dead card counting nothing down.
    vi.useFakeTimers();
    try {
      vi.setSystemTime((end + 1) * 1000);
      expect((await pm.fetchAllWindows(false)).some(w => w.interval === "1h")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("formats a long countdown as h:mm:ss", async () => {
    routes = [
      [/^\/markets\?slug=/, []],
      [/^\/series\?slug=btc-up-or-down-daily/, [{ id: "41" }]],
      [/^\/series\?slug=/, []],
      [/^\/events\?series_id=41/, [event("live", nowSec() + 2 * HOUR + 125)]],
    ];
    const wins = await pm.fetchAllWindows(false);
    const daily = wins.find(w => w.interval === "1d")!;
    expect(daily.secs_str).toMatch(/^2:0[12]:\d\d$/);
  });
});

// ── History ───────────────────────────────────────────────────────────────────

describe("fetchWindowHistory on a series slug", () => {
  it("reads winners off the series' closed events, newest first", async () => {
    const end = 1_800_000_000;
    const closed = (slug: string, endTs: number, prices: string) => ({
      slug,
      markets: [{ slug, endDate: iso(endTs), closed: true, outcomePrices: prices }],
    });
    routes = [
      [/^\/series\?slug=btc-up-or-down-hourly/, [{ id: "10114" }]],
      [/^\/events\?series_id=10114&limit=\d+&closed=true/, [
        closed("11am", end,          '["0", "1"]'),
        closed("10am", end - HOUR,   '["1", "0"]'),
        closed("9am",  end - 2 * HOUR, '["0.5", "0.5"]'),   // unresolved
      ]],
    ];

    const out = await pm.fetchWindowHistory("btc-up-or-down-hourly", 60, 8, end + HOUR);
    expect(out.map(r => r.winner)).toEqual(["DOWN", "UP", "?"]);
    expect(out.map(r => r.end_ts)).toEqual([end, end - HOUR, end - 2 * HOUR]);
    // It must NOT try to build <slug>-<epoch> per-window slugs for a series.
    expect(seen.some(p => p.startsWith("/markets?slug="))).toBe(false);
  });

  it("returns nothing when the series doesn't exist", async () => {
    routes = [[/^\/series\?slug=/, []]];
    expect(await pm.fetchWindowHistory("sol-up-or-down-daily", 1440, 8)).toEqual([]);
  });
});

// ── Meta ──────────────────────────────────────────────────────────────────────

describe("fetchWindowMeta on a series slug", () => {
  it("finds the window ending at the boundary and reads its outcome", async () => {
    const end = 1_800_000_000;
    routes = [
      [/^\/series\?slug=btc-up-or-down-daily/, [{ id: "41" }]],
      [/^\/events\?series_id=41&limit=\d+&closed=true/, [{
        slug: "day",
        markets: [{
          slug: "day",
          endDate: iso(end),
          closed: true,
          conditionId: "0xday",
          clobTokenIds: JSON.stringify(["up-day", "dn-day"]),
          outcomePrices: '["1", "0"]',
        }],
      }]],
      [/^\/events\?series_id=41&limit=\d+&closed=false/, []],
    ];

    expect(await pm.fetchWindowMeta("btc-up-or-down-daily", end)).toEqual({
      token: "up-day",
      condition_id: "0xday",
      series_id: "41",
      outcome: "UP",
      closed: true,
    });
  });

  it("returns blanks when no window ends at that boundary", async () => {
    routes = [
      [/^\/series\?slug=btc-up-or-down-daily/, [{ id: "41" }]],
      [/^\/events\?series_id=41/, []],
    ];
    const out = await pm.fetchWindowMeta("btc-up-or-down-daily", 1_800_000_000);
    expect(out).toEqual({ token: "", condition_id: "", series_id: "", outcome: "", closed: false });
  });
});
