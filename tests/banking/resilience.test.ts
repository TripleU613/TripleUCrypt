import { describe, it, expect, vi } from "vitest";
import { isTransient, withRetries } from "../../src/banking/resilience.js";

describe("isTransient", () => {
  it("returns true for 429 error", () => {
    expect(isTransient(new Error("HTTP 429 too many requests"))).toBe(true);
  });

  it("returns true for 503 error", () => {
    expect(isTransient(new Error("503 service unavailable"))).toBe(true);
  });

  it("returns true for timeout", () => {
    expect(isTransient(new Error("Request timed out"))).toBe(true);
  });

  it("returns true for connection error", () => {
    expect(isTransient(new Error("ECONNREFUSED connection refused"))).toBe(true);
  });

  it("returns true for rate limit", () => {
    expect(isTransient(new Error("rate limit exceeded"))).toBe(true);
  });

  it("returns true for gateway error", () => {
    expect(isTransient(new Error("502 bad gateway"))).toBe(true);
  });

  it("returns false for 401 unauthorized", () => {
    expect(isTransient(new Error("401 unauthorized"))).toBe(false);
  });

  it("returns false for 403 forbidden", () => {
    expect(isTransient(new Error("403 forbidden"))).toBe(false);
  });

  it("returns false for insufficient balance", () => {
    expect(isTransient(new Error("insufficient balance"))).toBe(false);
  });

  it("returns false for invalid error", () => {
    expect(isTransient(new Error("invalid signature"))).toBe(false);
  });

  it("returns false for signature error", () => {
    expect(isTransient(new Error("bad signature"))).toBe(false);
  });

  it("returns false for rejected", () => {
    expect(isTransient(new Error("rejected by server"))).toBe(false);
  });
});

describe("withRetries", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await withRetries(fn, 3, 0.001, "test");
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient errors up to attempts times", async () => {
    const transient = new Error("timeout error");
    const fn = vi.fn()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValue("ok");
    const result = await withRetries(fn, 3, 0.001, "test");
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry fatal errors", async () => {
    const fatal = new Error("401 unauthorized");
    const fn = vi.fn().mockRejectedValue(fatal);
    await expect(withRetries(fn, 3, 0.001, "test")).rejects.toThrow("401 unauthorized");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting retries on transient errors", async () => {
    const transient = new Error("503 unavailable");
    const fn = vi.fn().mockRejectedValue(transient);
    await expect(withRetries(fn, 3, 0.001, "test")).rejects.toThrow("503 unavailable");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("uses default attempts of 3", async () => {
    const transient = new Error("timeout");
    const fn = vi.fn().mockRejectedValue(transient);
    await expect(withRetries(fn)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
