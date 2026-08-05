/**
 * swap — in-app token swaps (USDC ↔ USDC.e ↔ POL) via Uniswap V3 directly, plus
 * the auto-gas mechanism that keeps the trading wallet topped up with POL.
 *
 * No third-party API/key: we read prices straight from Uniswap's QuoterV2 and
 * build SwapRouter02 calldata ourselves. The only external thing is Uniswap's
 * on-chain contracts (public infrastructure) — pools/fees verified live on
 * Polygon (USDC↔USDC.e = 0.01%, anything↔WMATIC = 0.05%).
 *
 * SECURITY: the private key is used only to sign in-process (viem). Never logged.
 */

import {
  createPublicClient, createWalletClient, http, getAddress, encodeFunctionData, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

import { POLYGON_RPC, NATIVE_USDC, USDC_E } from "./models.js";

// Uniswap V3 on Polygon (verified addresses).
const ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"; // SwapRouter02
const QUOTER = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e"; // QuoterV2
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"; // wrapped POL
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002"; // SwapRouter02 sentinel = router

const MAX_UINT = 2n ** 256n - 1n;

export type SwapToken = "USDC_NATIVE" | "USDC_E" | "POL";

function tokenAddr(t: SwapToken): string {
  return t === "USDC_NATIVE" ? NATIVE_USDC : t === "USDC_E" ? USDC_E : WMATIC;
}
function decimalsOf(t: SwapToken): number { return t === "POL" ? 18 : 6; }
function isNative(t: SwapToken): boolean { return t === "POL"; }
/** USDC↔USDC.e sits in the 0.01% pool; anything↔WMATIC in the 0.05% pool. */
function feeFor(a: SwapToken, b: SwapToken): number {
  const stable = (t: SwapToken) => t === "USDC_NATIVE" || t === "USDC_E";
  return stable(a) && stable(b) ? 100 : 500;
}

export interface SwapQuote {
  to: Hex;
  data: Hex;
  value: bigint;
  buyAmount: bigint;
  minBuyAmount: bigint;
  sellAmount: bigint;
  sellToken: Hex;
  allowanceTarget: Hex | null; // spender to approve (the router) — null when selling native
  nativeOut: boolean;
}

/** Thrown when the wallet has nothing to convert into gas — UI prompts funding. */
export class NeedsFundingError extends Error {
  constructor(msg = "Trading wallet has no POL and nothing to swap for gas — add a little POL first") {
    super(msg);
    this.name = "NeedsFundingError";
  }
}

function minGasWei(): bigint {
  const env = (process.env["TUC_MIN_GAS_POL"] ?? "").trim();
  const pol = env ? Number(env) : 0.05;
  return BigInt(Math.round((Number.isFinite(pol) && pol > 0 ? pol : 0.05) * 1e18));
}

// ── ABIs ──────────────────────────────────────────────────────────────────────
const QUOTER_ABI = [{
  name: "quoteExactInputSingle", type: "function", stateMutability: "nonpayable",
  inputs: [{ type: "tuple", components: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" }, { name: "fee", type: "uint24" },
    { name: "sqrtPriceLimitX96", type: "uint160" },
  ] }],
  outputs: [
    { name: "amountOut", type: "uint256" }, { name: "sqrtPriceX96After", type: "uint160" },
    { name: "initializedTicksCrossed", type: "uint32" }, { name: "gasEstimate", type: "uint256" },
  ],
}] as const;

const ROUTER_ABI = [
  { name: "exactInputSingle", type: "function", stateMutability: "payable",
    inputs: [{ type: "tuple", components: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" }, { name: "recipient", type: "address" },
      { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ] }],
    outputs: [{ name: "amountOut", type: "uint256" }] },
  { name: "unwrapWETH9", type: "function", stateMutability: "payable",
    inputs: [{ name: "amountMinimum", type: "uint256" }, { name: "recipient", type: "address" }], outputs: [] },
  { name: "multicall", type: "function", stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ name: "results", type: "bytes[]" }] },
] as const;

const ERC20_ABI = [
  { name: "allowance", type: "function", stateMutability: "view",
    inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
] as const;

function makePublicClient() {
  return createPublicClient({ chain: polygon, transport: http(POLYGON_RPC) });
}
function makeWalletClient(privateKey: string) {
  const pk = (privateKey.startsWith("0x") ? privateKey : "0x" + privateKey) as Hex;
  const account = privateKeyToAccount(pk);
  return { account, client: createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC) }) };
}

/** Read the expected output for a single-pool swap (QuoterV2, read-only). */
async function quoteOut(tokenIn: string, tokenOut: string, fee: number, amountIn: bigint): Promise<bigint> {
  const pc = makePublicClient();
  const { result } = await pc.simulateContract({
    address: getAddress(QUOTER), abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
    args: [{ tokenIn: getAddress(tokenIn), tokenOut: getAddress(tokenOut), amountIn, fee, sqrtPriceLimitX96: 0n }],
  });
  return (result as readonly bigint[])[0];
}

/**
 * Build a Uniswap V3 swap quote + ready-to-send tx for sell→buy of `sellAmount`
 * base units. For a native-POL output we wrap the swap + unwrap in a multicall so
 * the taker receives native POL. Read-only (no signing).
 */
export async function getSwapQuote(args: {
  sell: SwapToken; buy: SwapToken; sellAmount: bigint; taker: string; slippageBps?: number;
}): Promise<SwapQuote> {
  const tin = tokenAddr(args.sell), tout = tokenAddr(args.buy);
  const fee = feeFor(args.sell, args.buy);
  const taker = getAddress(args.taker);
  const out = await quoteOut(tin, tout, fee, args.sellAmount);
  if (out <= 0n) throw new Error("No swap route / no liquidity");
  const minOut = (out * (10000n - BigInt(args.slippageBps ?? 100))) / 10000n;
  const nativeOut = isNative(args.buy);
  const nativeIn = isNative(args.sell);

  const recipient = nativeOut ? getAddress(ADDRESS_THIS) : taker;
  const exactInput = encodeFunctionData({
    abi: ROUTER_ABI, functionName: "exactInputSingle",
    args: [{ tokenIn: getAddress(tin), tokenOut: getAddress(tout), fee, recipient, amountIn: args.sellAmount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
  });

  let data: Hex;
  if (nativeOut) {
    const unwrap = encodeFunctionData({ abi: ROUTER_ABI, functionName: "unwrapWETH9", args: [minOut, taker] });
    data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "multicall", args: [[exactInput, unwrap]] });
  } else {
    data = exactInput;
  }

  return {
    to: getAddress(ROUTER), data, value: nativeIn ? args.sellAmount : 0n,
    buyAmount: out, minBuyAmount: minOut, sellAmount: args.sellAmount,
    sellToken: getAddress(tin), allowanceTarget: nativeIn ? null : getAddress(ROUTER), nativeOut,
  };
}

/** Sign + broadcast a swap with the local key. Approves the router first if needed. */
export async function executeSwap(privateKey: string, quote: SwapQuote): Promise<{ hash: string; bought: bigint }> {
  const { account, client: walletClient } = makeWalletClient(privateKey);
  const publicClient = makePublicClient();

  if (quote.allowanceTarget) {
    const cur = await publicClient.readContract({
      address: quote.sellToken, abi: ERC20_ABI, functionName: "allowance", args: [account.address, quote.allowanceTarget],
    });
    if (BigInt(String(cur)) < quote.sellAmount) {
      const h = await walletClient.writeContract({
        address: quote.sellToken, abi: ERC20_ABI, functionName: "approve", args: [quote.allowanceTarget, MAX_UINT],
      });
      await publicClient.waitForTransactionReceipt({ hash: h });
    }
  }

  const hash = await walletClient.sendTransaction({ to: quote.to, data: quote.data, value: quote.value });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash, bought: quote.minBuyAmount };
}

// ── Convenience wrappers ──────────────────────────────────────────────────────

export async function swapUsdcToUsdcE(privateKey: string, microIn: bigint): Promise<string> {
  const { account } = makeWalletClient(privateKey);
  const q = await getSwapQuote({ sell: "USDC_NATIVE", buy: "USDC_E", sellAmount: microIn, taker: account.address });
  return (await executeSwap(privateKey, q)).hash;
}

export async function swapUsdcToPol(privateKey: string, microIn: bigint): Promise<string> {
  const { account } = makeWalletClient(privateKey);
  const q = await getSwapQuote({ sell: "USDC_E", buy: "POL", sellAmount: microIn, taker: account.address });
  return (await executeSwap(privateKey, q)).hash;
}

// ── Auto-gas ──────────────────────────────────────────────────────────────────

/**
 * Ensure the wallet holds at least `minPol` POL, swapping a little USDC.e → POL
 * if it's short. Zero POL → NeedsFundingError (can't pay for the bootstrap swap).
 */
export async function ensureGas(privateKey: string, minPol?: bigint): Promise<void> {
  const floor = minPol ?? minGasWei();
  const { account } = makeWalletClient(privateKey);
  const publicClient = makePublicClient();

  const bal = await publicClient.getBalance({ address: account.address });
  if (bal >= floor) return;
  if (bal === 0n) throw new NeedsFundingError();

  // Top up to 1.5× floor. Value the needed POL in USDC.e micro-units (~$0.07/POL
  // observed; oversize a touch — gas is cheap and the swap returns what it returns).
  const targetWei = (floor * 3n) / 2n;
  const neededPol = Number(targetWei - bal) / 1e18;
  const microIn = BigInt(Math.max(1, Math.ceil(neededPol * 0.1 * 1e6)));
  await swapUsdcToPol(privateKey, microIn);
}

// Exposed for unit tests.
export const _internal = { feeFor, tokenAddr, decimalsOf, isNative };
