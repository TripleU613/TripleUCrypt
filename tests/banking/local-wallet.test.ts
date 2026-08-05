import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { LocalWallet } from "../../src/banking/local-wallet.js";

let tmpDir: string;
let wallet: LocalWallet;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-test-"));
  wallet = new LocalWallet(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("LocalWallet", () => {
  describe("exists", () => {
    it("returns false before generate", () => {
      expect(wallet.exists()).toBe(false);
    });

    it("returns true after generate", () => {
      wallet.generate();
      expect(wallet.exists()).toBe(true);
    });
  });

  describe("generate", () => {
    it("creates a file and returns a valid checksummed address", () => {
      const addr = wallet.generate();
      expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
      // EIP-55 checksum: mixed case
      expect(addr).not.toBe(addr.toLowerCase());
    });

    it("address() returns the same address after generate", () => {
      const addr = wallet.generate();
      expect(wallet.address()).toBe(addr);
    });

    it("creates the plaintext file with mode 0600", () => {
      wallet.generate();
      const walletFile = path.join(tmpDir, "trading_wallet.json");
      expect(fs.existsSync(walletFile)).toBe(true);
      const stats = fs.statSync(walletFile);
      // On Linux, mode 0600 = 33024 = 0o100600
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it("refuses to clobber existing wallet without overwrite=true", () => {
      wallet.generate();
      expect(() => wallet.generate()).toThrow(/already exists/);
    });

    it("overwrites when overwrite=true", () => {
      const addr1 = wallet.generate();
      const addr2 = wallet.generate(undefined, true);
      // Different keys should yield (almost certainly) different addresses
      expect(addr2).toMatch(/^0x[0-9a-fA-F]{40}$/);
      // Both are valid even if they happen to be the same (astronomically unlikely)
    });
  });

  describe("importKey", () => {
    it("persists an existing private key and returns the correct address", () => {
      // Use a known test key
      const testKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
      const expectedAddr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
      const addr = wallet.importKey(testKey);
      expect(addr.toLowerCase()).toBe(expectedAddr.toLowerCase());
    });
  });

  describe("address", () => {
    it("returns empty string when no wallet exists", () => {
      expect(wallet.address()).toBe("");
    });

    it("returns checksummed address after generate", () => {
      wallet.generate();
      const addr = wallet.address();
      expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });
  });

  describe("signer", () => {
    it("returns a PrivateKeyAccount after generate", () => {
      wallet.generate();
      const acct = wallet.signer();
      expect(acct).toBeDefined();
      expect(typeof acct.address).toBe("string");
      expect(acct.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("signer address matches address()", () => {
      wallet.generate();
      const addr = wallet.address();
      const acct = wallet.signer();
      expect(acct.address.toLowerCase()).toBe(addr.toLowerCase());
    });

    it("throws if no wallet exists", () => {
      expect(() => wallet.signer()).toThrow(/No local trading wallet/);
    });
  });

  describe("delete", () => {
    it("removes the file", () => {
      wallet.generate();
      expect(wallet.exists()).toBe(true);
      wallet.delete();
      expect(wallet.exists()).toBe(false);
    });

    it("address() returns empty string after delete", () => {
      wallet.generate();
      wallet.delete();
      expect(wallet.address()).toBe("");
    });
  });

  describe("security invariants", () => {
    it("private key is never returned by address()", () => {
      wallet.generate();
      const addr = wallet.address();
      // address() should be a 42-char hex, not a 66-char private key
      expect(addr.length).toBe(42);
    });

    it("private key is never returned by exists()", () => {
      wallet.generate();
      const result = wallet.exists();
      expect(typeof result).toBe("boolean");
    });

    it("toString() does not contain private key", () => {
      wallet.generate();
      const str = wallet.toString();
      // Private keys are 64-hex chars after 0x prefix
      // The repr should not contain 64+ char hex strings beyond the address
      const hexMatches = str.match(/[0-9a-f]{64}/gi) ?? [];
      expect(hexMatches.length).toBe(0);
    });
  });
});
