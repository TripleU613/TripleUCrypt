/**
 * Polymarket RTDS Chainlink oracle feed parser.
 * Mirrors TripleUCrypt/io/chainlink.py exactly.
 */

export const RTDS_URL = "wss://ws-live-data.polymarket.com";

const _TOPIC = "crypto_prices_chainlink";

const _SYMBOL_ASSET: Record<string, string> = {
  "btc/usd":  "BTC",
  "eth/usd":  "ETH",
  "sol/usd":  "SOL",
  "xrp/usd":  "XRP",
  "doge/usd": "DOGE",
  "hype/usd": "HYPE",
  "bnb/usd":  "BNB",
};

/**
 * Returns the JSON subscription frame for the Chainlink oracle price feed.
 */
export function subscribeMsg(): string {
  return JSON.stringify({
    action: "subscribe",
    subscriptions: [{ topic: "crypto_prices_chainlink", type: "*" }],
  });
}

/**
 * Parse a raw RTDS WebSocket message string.
 * Returns {asset, price} or null if not a valid Chainlink price update.
 */
export function parseMsg(raw: string): { asset: string; price: number } | null {
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    if (d["topic"] !== _TOPIC) return null;
    const payload = d["payload"] as Record<string, unknown> | undefined;
    if (!payload) return null;
    const symbol = String(payload["symbol"] ?? "").toLowerCase();
    const asset = _SYMBOL_ASSET[symbol];
    if (!asset) return null;
    const price = parseFloat(String(payload["value"] ?? "0"));
    if (!isFinite(price) || price <= 0) return null;
    return { asset, price };
  } catch {
    return null;
  }
}
