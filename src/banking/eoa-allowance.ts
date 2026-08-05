/**
 * eoa-allowance — one-time on-chain approvals + withdrawal for a generated-EOA trader.
 *
 * A generated EOA (signature_type 0) holds its own funds, so it must approve
 * the exchange contracts on-chain before orders can fill — ERC-20 approve and
 * CTF setApprovalForAll for each Polymarket exchange.
 *
 * GATED: nothing here broadcasts a real transaction unless the relevant env gate
 * is set.
 *
 * SECURITY: the private key is passed in only to sign in-process (viem does the
 * signing — never hand-rolled). It is never logged, returned, or stored.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  getAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

import { ensureGas, NeedsFundingError } from "./swap.js";

import {
  POLYGON_RPC,
  POLYGON_CHAIN_ID,
  USDC_E,
  CTF_ADDRESS,
  CTF_EXCHANGE,
  NEG_RISK_EXCHANGE,
  NEG_RISK_ADAPTER,
  CLOB_HOST,
} from "./models.js";

const MAX_UINT = (2n ** 256n - 1n);
const APPROVE_THRESHOLD = MAX_UINT / 2n;

// ── Minimal ABIs ──────────────────────────────────────────────────────────────

const ERC20_ABI = [
  {
    name: "allowance", type: "function", stateMutability: "view",
    inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "transfer", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "a", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "o", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const CTF_ABI = [
  {
    name: "isApprovedForAll", type: "function", stateMutability: "view",
    inputs: [{ name: "o", type: "address" }, { name: "op", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "setApprovalForAll", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "op", type: "address" }, { name: "ok", type: "bool" }],
    outputs: [],
  },
  {
    name: "redeemPositions", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSets", type: "uint256[]" },
    ],
    outputs: [],
  },
] as const;

// ── Neg-risk detection ─────────────────────────────────────────────────────────
// A market is "neg-risk" (multi-outcome winner-take-all) when its CLOB market
// record carries `neg_risk: true`. Such markets must be redeemed through the
// NEG_RISK_ADAPTER, NOT the bare CTF redeemPositions([1,2]) route (which reverts
// or claims nothing). We read this from the public CLOB market endpoint keyed by
// conditionId — no signer/key needed. Returns null when it can't be determined so
// the caller can refuse rather than guess.
async function isNegRiskCondition(conditionId: string): Promise<boolean | null> {
  try {
    const cond = conditionId.startsWith("0x") ? conditionId : "0x" + conditionId;
    const r = await fetch(`${CLOB_HOST}/markets/${cond}`);
    if (!r.ok) return null;
    const data = await r.json() as Record<string, unknown>;
    const v = data["neg_risk"] ?? data["negRisk"];
    if (typeof v === "boolean") return v;
    return null;
  } catch {
    return null;
  }
}

// ── Gate helpers ──────────────────────────────────────────────────────────────
//
// Real-money on-chain ops used to require an .env flag (preview-locked). They are
// now unlocked at runtime by an explicit in-app confirm ("Enable trading"), which
// flips a per-process armed flag. The legacy env flags still work (back-compat for
// existing .env-proxy installs) — either path opens the gate.
//
// The flag is per-process and resets on restart: safe default-OFF, one click arms
// the session. It is NEVER persisted to disk.

let _armed = false;

/** Arm real-money on-chain ops for this process (called after a UI confirm). */
export function armLiveOps(): void { _armed = true; }

/** Whether real-money ops are armed (in-app confirm) for this process. */
export function liveOpsArmed(): boolean { return _armed; }

function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(
    (process.env[name] ?? "").trim().toLowerCase()
  );
}

function approveEnabled(): boolean {
  return _armed || envFlag("TUC_EOA_APPROVE_ENABLED");
}

function redeemEnabled(): boolean {
  return _armed || envFlag("TUC_REDEEM_ENABLED");
}

/**
 * Gate for the USER-FACING swap / gas-top-up broker methods (LiveBroker.swap,
 * LiveBroker.topUpGas) — both broadcast real on-chain txs (a Uniswap V3 swap
 * spending real USDC.e/POL, or a gas top-up), so they need the same
 * default-OFF treatment as every other on-chain write path here.
 *
 * NOTE: this deliberately does NOT gate the internal topUpGas() wrapper below.
 * That one is an auto-gas step for ensureEoaAllowances/eoaWithdraw/redeemEoa,
 * whose CALLERS are already gated by approveEnabled()/redeemEnabled() — gating
 * it again here would break those flows for anyone who set only
 * TUC_EOA_APPROVE_ENABLED / TUC_REDEEM_ENABLED.
 */
export function swapEnabled(): boolean {
  return _armed || envFlag("TUC_SWAP_ENABLED");
}

// ── Auto-gas wrapper ──────────────────────────────────────────────────────────
// Ensure the wallet has POL before an on-chain op. A zero-balance wallet can't
// transact at all → hard fail so the UI prompts a MetaMask gas seed. Any other
// top-up failure (e.g. no swap API key) is best-effort: proceed and let the op
// revert with a precise error if gas is genuinely insufficient.
async function topUpGas(privateKey: string): Promise<void> {
  try {
    await ensureGas(privateKey);
  } catch (e) {
    if (e instanceof NeedsFundingError) throw e;
    console.warn("ensureGas (best-effort):", e instanceof Error ? e.message : e);
  }
}

// ── Client factory ────────────────────────────────────────────────────────────

function makePublicClient() {
  return createPublicClient({
    chain: polygon,
    transport: http(POLYGON_RPC),
  });
}

function makeWalletClient(privateKey: string) {
  const pk = (privateKey.startsWith("0x") ? privateKey : "0x" + privateKey) as Hex;
  const account = privateKeyToAccount(pk);
  return {
    account,
    client: createWalletClient({
      account,
      chain: polygon,
      transport: http(POLYGON_RPC),
    }),
  };
}

// ── Collateral token (USDC.e — Polymarket collateral) ────────────────────────
// The Python version reads this from py-clob-client's get_contract_config.
// In the TS layer we use the known USDC.e address directly (same source).
const COLLATERAL = USDC_E;
const SPENDERS = [CTF_EXCHANGE, NEG_RISK_EXCHANGE, NEG_RISK_ADAPTER];

// ── Public API ────────────────────────────────────────────────────────────────

export interface AllowanceStatus {
  ready: boolean;
  missing_erc20: string[];
  missing_ctf: string[];
}

/**
 * READ-ONLY (no key, no gas): which approvals the EOA still needs.
 * Safe to call anytime to drive UI.
 */
export async function allowanceStatus(ownerAddress: string): Promise<AllowanceStatus> {
  const client = makePublicClient();
  const owner = getAddress(ownerAddress);
  const collateral = getAddress(COLLATERAL);
  const ctf = getAddress(CTF_ADDRESS);

  const missing_erc20: string[] = [];
  const missing_ctf: string[] = [];

  for (const sp of SPENDERS) {
    const spender = getAddress(sp);

    const allowance = await client.readContract({
      address: collateral,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner, spender],
    });
    if (BigInt(String(allowance)) < APPROVE_THRESHOLD) {
      missing_erc20.push(spender);
    }

    const approved = await client.readContract({
      address: ctf,
      abi: CTF_ABI,
      functionName: "isApprovedForAll",
      args: [owner, spender],
    });
    if (!approved) {
      missing_ctf.push(spender);
    }
  }

  return {
    ready: missing_erc20.length === 0 && missing_ctf.length === 0,
    missing_erc20,
    missing_ctf,
  };
}

/**
 * Send the MISSING approvals on-chain (idempotent). Returns tx hashes.
 * GATED: raises unless TUC_EOA_APPROVE_ENABLED is set.
 */
export async function ensureEoaAllowances(privateKey: string): Promise<string[]> {
  if (!approveEnabled()) {
    throw new Error("Live trading not enabled — click Enable trading first");
  }
  await topUpGas(privateKey);

  const { account, client: walletClient } = makeWalletClient(privateKey);
  const publicClient = makePublicClient();
  const owner = account.address;
  const collateral = getAddress(COLLATERAL);
  const ctf = getAddress(CTF_ADDRESS);
  const sent: string[] = [];

  for (const sp of SPENDERS) {
    const spender = getAddress(sp);

    const allowance = await publicClient.readContract({
      address: collateral,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner, spender],
    });
    if (BigInt(String(allowance)) < APPROVE_THRESHOLD) {
      const hash = await walletClient.writeContract({
        address: collateral,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [spender, MAX_UINT],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      sent.push(hash);
    }

    const approved = await publicClient.readContract({
      address: ctf,
      abi: CTF_ABI,
      functionName: "isApprovedForAll",
      args: [owner, spender],
    });
    if (!approved) {
      const hash = await walletClient.writeContract({
        address: ctf,
        abi: CTF_ABI,
        functionName: "setApprovalForAll",
        args: [spender, true],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      sent.push(hash);
    }
  }

  console.info(`EOA allowances: broadcast ${sent.length} approval tx(s)`);
  return sent;
}

/**
 * On-chain ERC-20 transfer of `microAmount` (6-dec collateral micro-units)
 * from the EOA to `toAddress`. Returns the tx hash.
 * GATED behind TUC_EOA_APPROVE_ENABLED.
 */
export async function eoaWithdraw(
  privateKey: string,
  toAddress: string,
  microAmount: bigint | number,
): Promise<string> {
  if (!approveEnabled()) {
    throw new Error("Live trading not enabled — click Enable trading first");
  }
  const amount = BigInt(microAmount);
  if (amount <= 0n) throw new Error("Amount must be positive");
  await topUpGas(privateKey);

  const { account, client: walletClient } = makeWalletClient(privateKey);
  const publicClient = makePublicClient();
  const owner = account.address;
  const dest = getAddress(toAddress);
  const collateral = getAddress(COLLATERAL);

  const bal = await publicClient.readContract({
    address: collateral,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner],
  });
  if (amount > BigInt(String(bal))) {
    throw new Error("Amount exceeds on-chain balance");
  }

  const hash = await walletClient.writeContract({
    address: collateral,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [dest, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.info(`EOA withdraw: sent ${microAmount} micro-units`);
  return hash;
}

/**
 * Claim a RESOLVED position's payout on-chain.
 *
 *  • Binary CTF condition → CTF.redeemPositions(collateral, 0x0, conditionId, [1,2])
 *    (the winning slot pays out; the losing slot redeems to 0). This is the
 *    long-standing, verified path and is UNCHANGED.
 *  • Neg-risk condition   → MUST route through NEG_RISK_ADAPTER, NOT the bare CTF.
 *    The bare-CTF [1,2] route reverts/claims nothing for neg-risk, stranding the
 *    winnings. See the explicit guard below — we refuse rather than guess a
 *    destructive call when we can't compute the adapter args safely.
 *
 * GATED behind TUC_REDEEM_ENABLED.
 */
export async function redeemEoa(privateKey: string, conditionId: string): Promise<string> {
  if (!redeemEnabled()) {
    throw new Error("Live trading not enabled — click Enable trading first");
  }
  if (!conditionId) throw new Error("Missing condition_id");

  // Determine the redemption route BEFORE spending gas. If a market is neg-risk
  // the binary path is WRONG (would revert / strand funds), so branch first.
  const negRisk = await isNegRiskCondition(conditionId);
  if (negRisk === null) {
    throw new Error("Could not determine market type — claim not attempted");
  }
  if (negRisk) {
    // Neg-risk redemption goes through NEG_RISK_ADAPTER.redeemPositions(
    //   bytes32 conditionId, uint256[2] amounts  // [yesBalance, noBalance]
    // ) which does CTF.safeBatchTransferFrom(holder, adapter, positionIds, amounts).
    // The two positionIds are derived via CTHelpers.getPositionId(wcol,
    // getCollectionId(0, conditionId, {1,2})) — an alt_bn128 EC derivation that
    // is NOT available in any installed dependency and is unsafe to hand-roll.
    // Passing wrong amounts/ordering reverts; passing 0s claims nothing. Per the
    // stuck-funds brief we DO NOT guess a destructive on-chain call — we refuse
    // and surface a truthful error so the win is flagged for manual completion.
    throw new Error("Neg-risk redemption not yet supported — claim manually on Polymarket");
  }

  await topUpGas(privateKey);

  const { client: walletClient } = makeWalletClient(privateKey);
  const publicClient = makePublicClient();
  const ctf = getAddress(CTF_ADDRESS);
  const collateral = getAddress(COLLATERAL);

  const cond = (conditionId.startsWith("0x") ? conditionId : "0x" + conditionId) as Hex;
  const ZERO_BYTES32 = ("0x" + "00".repeat(32)) as Hex;

  // Encode the calldata to verify it works, then call via writeContract
  encodeFunctionData({
    abi: CTF_ABI,
    functionName: "redeemPositions",
    args: [collateral, ZERO_BYTES32, cond, [1n, 2n]],
  });

  const hash = await walletClient.writeContract({
    address: ctf,
    abi: CTF_ABI,
    functionName: "redeemPositions",
    args: [collateral, ZERO_BYTES32, cond, [1n, 2n]],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.info(`EOA redeem: claimed condition ${conditionId.slice(0, 12)}`);
  return hash;
}
