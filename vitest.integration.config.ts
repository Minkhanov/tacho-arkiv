import { defineConfig } from "vitest/config"

// Runs against the live Tiramisu testnet. Needs funded keys in .env (see .env.example).
export default defineConfig({
  test: {
    include: ["test/**/*.int.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
})
