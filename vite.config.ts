import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      "/agent-api": {
        target: process.env.CLAUDIO_AGENT_URL || "http://127.0.0.1:8081",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/agent-api/, "/api/lab"),
      },
    },
  },
});
