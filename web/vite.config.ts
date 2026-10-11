import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const target = process.env.SENTRYFLOW_SERVER ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // Same-origin proxy: the browser talks to /mcp on the Vite origin, so no CORS is needed and
    // the server's Origin allow-list still applies (Vite forwards the Origin header).
    proxy: {
      "/mcp": { target, changeOrigin: false },
      "/health": { target },
      "/api": { target },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          mcp: ["@modelcontextprotocol/sdk/client/index.js", "@modelcontextprotocol/sdk/client/streamableHttp.js"],
        },
      },
    },
  },
  test: { include: ["src/**/*.test.ts"] },
});
