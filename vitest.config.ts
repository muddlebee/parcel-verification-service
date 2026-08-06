import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // dotenv (loaded via `import "dotenv/config"` in src/config/env.ts)
    // never overwrites an already-set process.env value, so these win over
    // .env for the whole test run. Scaled way down purely so the
    // retry/backoff/exhaustion integration tests finish in seconds instead
    // of the real (already-scaled-down-from-30s) demo timing.
    env: {
      REGISTRY_RETRY_BASE_MS: "150",
      REGISTRY_CALL_TIMEOUT_MS: "250",
      REGISTRY_MAX_ATTEMPTS: "3",
      // Dedicated port so the retry-test file's real listener (needed
      // because the callback-delivery worker does a genuine HTTP loopback
      // to this port) can't collide with `npm run dev` or a compose `api`
      // container someone might have running on the default 3000.
      PORT: "3999",
    },
  },
});
