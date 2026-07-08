/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiProxy = { "/api": "http://127.0.0.1:5174" };

export default defineConfig({
  plugins: [react()],
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
  test: {
    globals: true,
    environment: "node",
    // Any test that imports server/db.ts (now or in future) must bootstrap
    // and use the test database, never the production RetirementForecast one.
    env: { RETIREMENT_DB_NAME: "RetirementForecastTest" },
  },
});
