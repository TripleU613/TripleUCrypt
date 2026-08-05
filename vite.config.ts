import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  root: "client/",
  // @polymarket/clob-client (ethereumjs-util / eth-sig-util) is a Node library —
  // it needs Buffer, events (EventEmitter), stream, crypto, util, process, global
  // in the browser. This plugin provides them all (dev optimize + build) and
  // injects the globals. Without it Vite externalizes those builtins to empty
  // stubs → "EventEmitter is not an object" / "buffer.Buffer undefined" crashes.
  plugins: [
    nodePolyfills({ globals: { Buffer: true, global: true, process: true } }),
    react(),
  ],
  // Pre-bundle so ESM entries are served as single optimized deps.
  optimizeDeps: {
    include: ["animejs", "ethers", "@polymarket/clob-client-v2"],
  },
  build: {
    outDir: "../dist/public",
    emptyOutDir: true,
    // NOTE: hand-partitioning vendors via manualChunks (ethers/clob-client into a
    // separate "web3" chunk) caused a circular chunk-init TDZ crash in prod
    // ("can't access lexical declaration before initialization"). Reverted to a
    // single bundle — correctness over the size warning. Proper first-load
    // splitting should be done via dynamic import() of the web3 path, not by
    // slicing interdependent vendor libs across chunk boundaries.
    chunkSizeWarningLimit: 2000,
  },
  server: {
    proxy: {
      "^/sse$": "http://localhost:8200",
      "^/action/": "http://localhost:8200",
      "^/health$": "http://localhost:8200",
      "^/swap-quote$": "http://localhost:8200",
      "^/allowance": "http://localhost:8200",
      // Route CLOB through Polymarket directly (strip /clob), same-origin to the browser.
      "^/clob/": {
        target: "https://clob.polymarket.com",
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/clob/, ""),
      },
    },
  },
});
