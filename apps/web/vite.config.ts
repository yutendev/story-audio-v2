// T8.1 — Vite cho apps/web: dev server proxy /api → API Node (localhost:3000) để
// frontend luôn same-origin (không CORS, KHÔNG secret nào nằm trong web).
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3000" },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
