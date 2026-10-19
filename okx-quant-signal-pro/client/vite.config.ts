import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // GitHub Pages alt yolu: https://nora-seed.github.io/okx-quant-signal-pro/
  base: "/okx-quant-signal-pro/",
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:3001", changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 600 },
});
