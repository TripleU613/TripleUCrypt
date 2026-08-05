/**
 * local-wallet — a generated, locally-persisted trading keypair.
 *
 * WHY THIS EXISTS
 * ---------------
 * The app generates a dedicated, low-value trading keypair locally. The user
 * funds its address from MetaMask (send USDC to the shown deposit address),
 * and ALL order signing stays server-side (instant, popup-free).
 *
 * KEY-AT-REST
 * -----------
 * * PLAINTEXT (implemented): `trading_wallet.json` = {address, private_key}, mode 0600.
 * * KEYSTORE v3 (TODO): encrypted with a user password — viem doesn't have
 *   built-in keystore v3 encrypt/decrypt; add when an ethers/eth-account
 *   compatible library is added as a dependency.
 *
 * SECURITY INVARIANTS
 * --------------------
 * * The private key is NEVER logged, printed, or put in repr/str.
 * * No public method RETURNS the raw key as a string.
 * * The ONLY way to obtain a usable signer is `signer()`.
 * * `address()` / `exists()` are always safe to surface.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";
import { getAddress } from "viem";

// ── File names ────────────────────────────────────────────────────────────────
const PLAINTEXT_NAME = "trading_wallet.json";
// TODO: ENCRYPTED_NAME = "trading_wallet.keystore.json"
// Implement keystore v3 encrypt/decrypt when a compatible library is available.

// ── Data dir (shared with paper ledger) ──────────────────────────────────────
function dataDir(): string {
  const d = (process.env["TC_DATA_DIR"] ?? "").trim();
  const base = d ? d : path.join(os.homedir(), ".triplecrypt");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

// ── Atomic write, owner-only ──────────────────────────────────────────────────
function atomicWrite(filePath: string, text: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.wallet_${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* best-effort */ }
    fs.renameSync(tmp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
}

// ── Checksum address ──────────────────────────────────────────────────────────
function checksumAddr(addr: string): string {
  if (!addr) return "";
  try {
    return getAddress(addr);
  } catch {
    return "";
  }
}

// ── LocalWallet ───────────────────────────────────────────────────────────────
export class LocalWallet {
  private readonly _dir: string;
  private readonly _plainPath: string;

  constructor(dataDirectory?: string) {
    this._dir = dataDirectory ?? dataDir();
    this._plainPath = path.join(this._dir, PLAINTEXT_NAME);
  }

  // ── introspection (always secret-free) ──────────────────────────────────────

  exists(): boolean {
    return fs.existsSync(this._plainPath);
  }

  /** Public 0x address of the stored wallet, or "" if none exists.
   *  Reads WITHOUT decrypting — never needs a password. */
  address(): string {
    try {
      if (fs.existsSync(this._plainPath)) {
        const d = JSON.parse(fs.readFileSync(this._plainPath, "utf8")) as { address?: string };
        return checksumAddr(String(d.address ?? "").trim());
      }
    } catch (e) {
      console.warn("local_wallet address() read failed:", e);
    }
    return "";
  }

  // ── creation ─────────────────────────────────────────────────────────────────

  /**
   * Generate a NEW keypair and persist it. Returns the PUBLIC address.
   * password param is reserved for future keystore v3 support (ignored for now).
   *
   * Refuses to clobber an existing wallet unless `overwrite=true`.
   */
  generate(_password?: string, overwrite = false): string {
    if (this.exists() && !overwrite) {
      throw new Error(
        "A local trading wallet already exists. Pass overwrite=true only " +
        "if you are sure (the old address' funds would be orphaned)."
      );
    }
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    this._persist(account.address, privateKey);
    return account.address;
  }

  /**
   * Persist an EXISTING private key. Returns the public address.
   * Same overwrite guard as generate().
   */
  importKey(privateKey: string, _password?: string, overwrite = false): string {
    if (this.exists() && !overwrite) {
      throw new Error("A local trading wallet already exists.");
    }
    // Normalize: ensure 0x prefix
    const pk = (privateKey.startsWith("0x") ? privateKey : "0x" + privateKey) as `0x${string}`;
    const account = privateKeyToAccount(pk);
    this._persist(account.address, pk);
    return account.address;
  }

  private _persist(address: string, privateKey: string): void {
    const body = JSON.stringify({ address, private_key: privateKey });
    atomicWrite(this._plainPath, body);
  }

  // ── the ONLY secret-bearing surface ──────────────────────────────────────────

  /**
   * Return the in-process PrivateKeyAccount signer.
   * This is the ONLY supported way to get something that can sign.
   * password param reserved for future keystore v3 support.
   *
   * Raises if no wallet exists.
   */
  signer(_password?: string): PrivateKeyAccount {
    if (!fs.existsSync(this._plainPath)) {
      throw new Error("No local trading wallet exists. Generate one first.");
    }
    const d = JSON.parse(fs.readFileSync(this._plainPath, "utf8")) as { private_key?: string };
    const pk = String(d.private_key ?? "");
    if (!pk) throw new Error("Plaintext wallet file is missing its key.");
    const normalized = (pk.startsWith("0x") ? pk : "0x" + pk) as `0x${string}`;
    return privateKeyToAccount(normalized);
  }

  delete(): void {
    try {
      if (fs.existsSync(this._plainPath)) fs.unlinkSync(this._plainPath);
    } catch (e) {
      console.warn("local_wallet could not remove", this._plainPath, ":", e);
    }
  }

  toString(): string {
    return `LocalWallet(dir=${JSON.stringify(this._dir)}, exists=${this.exists()})`;
  }
}

// ── Module-level singleton ────────────────────────────────────────────────────

let _default: LocalWallet | null = null;

export function defaultWallet(): LocalWallet {
  if (!_default) _default = new LocalWallet();
  return _default;
}

export function hasLocalWallet(): boolean {
  return defaultWallet().exists();
}

export function localWalletAddress(): string {
  return defaultWallet().address();
}
