/**
 * Resilience — bounded retries + clean classification for flaky calls.
 *
 * Polymarket's CLOB / data APIs return the occasional 5xx, timeout, or odd
 * transient error. We wrap every network call so the UI NEVER ends up in limbo:
 * either we get a value, or we get a typed failure we can surface as a status.
 *
 * No external deps. Pure async. Retries only on classified-transient errors;
 * fatal errors (bad signature, insufficient balance, 4xx) fail fast.
 */

// Substrings that mark an error as worth retrying (transient/network).
const TRANSIENT_MARKERS = [
  "timeout", "timed out", "temporarily", "connection", "connect",
  "reset", "econn", "503", "502", "504", "500", "gateway",
  "unavailable", "too many requests", "429", "rate limit",
];

// Substrings that mark an error as FATAL — never retry.
const FATAL_MARKERS = [
  "signature", "insufficient", "not enough", "balance", "allowance",
  "invalid", "unauthorized", "forbidden", "401", "403", "minimum",
  "rejected", "not configured",
];

/**
 * Classify whether an exception is worth a retry.
 */
export function isTransient(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  if (FATAL_MARKERS.some(m => msg.includes(m))) return false;
  if (TRANSIENT_MARKERS.some(m => msg.includes(m))) return true;
  // Unknown errors: treat network-ish exception types as transient, else fatal.
  const name = (err instanceof Error ? err.constructor.name : "").toLowerCase();
  return ["timeout", "connect", "network", "os", "http"].some(k => name.includes(k));
}

/**
 * Run `fn` (a zero-arg async thunk) with bounded retries on transient errors.
 * Re-raises the last error if all attempts fail or the error is fatal.
 *
 * Exponential backoff capped small — these are interactive trade paths, we
 * want a fast clean failure over a long hang.
 */
export async function withRetries<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelay = 0.25,
  label = "call",
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isTransient(e) || i === attempts - 1) {
        const reason = !isTransient(e) ? "fatal" : "exhausted";
        console.warn(`${label} failed (attempt ${i + 1}/${attempts}, ${reason}):`, e);
        throw e;
      }
      const delay = baseDelay * Math.pow(2, i);
      console.info(`${label} transient error (attempt ${i + 1}/${attempts}), retrying in ${delay.toFixed(2)}s:`, e);
      await new Promise(r => setTimeout(r, delay * 1000));
    }
  }
  // Unreachable, but keeps type-checkers happy.
  throw last;
}

/**
 * A compact, UI-safe error string (never includes secrets).
 */
export function shortError(err: unknown, limit = 70): string {
  const s = String(err).trim().replace(/\n/g, " ");
  return s.slice(0, limit);
}
