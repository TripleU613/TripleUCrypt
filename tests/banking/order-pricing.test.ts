import { describe, it, expect } from "vitest";
import {
  slippageCapCents,
  slippageFloorCents,
  MAX_SLIPPAGE,
  DEFAULT_TICK,
  MIN_ORDER_USD,
  MIN_SHARES,
} from "../../src/banking/models.js";
import { clampToTick } from "../../src/banking/live.js";

// ── Money-critical constants ──────────────────────────────────────────────────
describe("banking constants", () => {
  it("have the expected values", () => {
    expect(MAX_SLIPPAGE).toBe(0.02);
    expect(DEFAULT_TICK).toBe(0.01);
    expect(MIN_ORDER_USD).toBe(1);
    expect(MIN_SHARES).toBe(0.01);
  });
});

// ── slippageCapCents — marketable BUY cap ───────────────────────────────────────
describe("slippageCapCents", () => {
  it("caps a 60¢ ask at ask×1.02 snapped UP to the tick (61.2 → 62)", () => {
    // 60 × 1.02 = 61.2 → ceil to the 1¢ grid → 62
    expect(slippageCapCents(60)).toBe(62);
  });

  it("snaps up to the next tick when not exactly on the grid", () => {
    // 50 × 1.02 = 51 → already on grid → 51
    expect(slippageCapCents(50)).toBe(51);
    // 33 × 1.02 = 33.66 → ceil → 34
    expect(slippageCapCents(33)).toBe(34);
  });

  it("clamps so the cap never exceeds (1 - tick) = 99¢", () => {
    // 99 × 1.02 = 100.98 → clamp to 99 → 99
    expect(slippageCapCents(99)).toBe(99);
    // even a 100¢ ask cannot push the cap above 99
    expect(slippageCapCents(100)).toBe(99);
    expect(slippageCapCents(98)).toBe(99); // 98×1.02=99.96 → clamp 99
  });

  it("clamps up to the tick floor for a tiny ask", () => {
    // 0.5 × 1.02 = 0.51 → below tick (1) → clamp to 1 → 1
    expect(slippageCapCents(0.5)).toBe(1);
  });

  it("returns null for no / zero / negative / NaN ask", () => {
    expect(slippageCapCents(0)).toBeNull();
    expect(slippageCapCents(-5)).toBeNull();
    expect(slippageCapCents(NaN)).toBeNull();
    // @ts-expect-error — exercising the runtime guard with undefined
    expect(slippageCapCents(undefined)).toBeNull();
  });

  it("honours a custom tick size (5¢ grid)", () => {
    // tickCents = 5; 60×1.02 = 61.2 → ceil to 5¢ grid → 65
    expect(slippageCapCents(60, 0.05)).toBe(65);
  });
});

// ── slippageFloorCents — marketable SELL floor ──────────────────────────────────
describe("slippageFloorCents", () => {
  it("floors a mid bid at bid×0.98 snapped DOWN to the tick", () => {
    // 50 × 0.98 = 49 → floor → 49
    expect(slippageFloorCents(50)).toBe(49);
    // 60 × 0.98 = 58.8 → floor → 58
    expect(slippageFloorCents(60)).toBe(58);
  });

  it("clamps to the tick floor (1¢) for a tiny bid", () => {
    // 1 × 0.98 = 0.98 → below tick → clamp to 1 → 1
    expect(slippageFloorCents(1)).toBe(1);
    // 0.5 × 0.98 = 0.49 → clamp to 1 → 1
    expect(slippageFloorCents(0.5)).toBe(1);
  });

  it("respects the (1 - tick) ceiling clamp for a high bid", () => {
    // 100 × 0.98 = 98 → 98 (within bounds)
    expect(slippageFloorCents(100)).toBe(98);
    // 101 × 0.98 = 98.98 → within [1,99] → floor → 98
    expect(slippageFloorCents(101)).toBe(98);
    // A bid whose ×0.98 exceeds 99 is clamped to 99 before flooring:
    // 102 × 0.98 = 99.96 → clamp to 99 → floor → 99
    expect(slippageFloorCents(102)).toBe(99);
  });

  it("returns null for no / zero / negative / NaN bid", () => {
    expect(slippageFloorCents(0)).toBeNull();
    expect(slippageFloorCents(-1)).toBeNull();
    expect(slippageFloorCents(NaN)).toBeNull();
    // @ts-expect-error — exercising the runtime guard with undefined
    expect(slippageFloorCents(undefined)).toBeNull();
  });

  it("honours a custom tick size (5¢ grid)", () => {
    // tickCents = 5; 60×0.98 = 58.8 → floor to 5¢ grid → 55
    expect(slippageFloorCents(60, 0.05)).toBe(55);
  });
});

// ── clampToTick — CLOB order-price grid snap (module-local helper, exported) ─────
describe("clampToTick", () => {
  it("clamps into [tick, 1 - tick] and snaps to the grid", () => {
    expect(clampToTick(0.999)).toBe(0.99); // above ceiling → 0.99
    expect(clampToTick(0.0001)).toBe(0.01); // below floor → 0.01
    expect(clampToTick(0.617)).toBe(0.62); // 0.617 → nearest tick 0.62
  });

  it("clamps both hard bounds", () => {
    expect(clampToTick(5)).toBe(0.99); // far above → 0.99
    expect(clampToTick(-5)).toBe(0.01); // far below → 0.01
    expect(clampToTick(0)).toBe(0.01);
    expect(clampToTick(1)).toBe(0.99);
  });

  it("snaps to the nearest tick (rounding)", () => {
    expect(clampToTick(0.614)).toBe(0.61); // rounds down
    expect(clampToTick(0.615)).toBe(0.62); // rounds up (banker's-free Math.round)
    expect(clampToTick(0.5)).toBe(0.5);
  });

  it("honours a custom tick size", () => {
    expect(clampToTick(0.617, 0.05)).toBe(0.6); // nearest 5¢ → 0.60
    expect(clampToTick(0.999, 0.05)).toBe(0.95); // ceiling = 1 - 0.05
  });
});
