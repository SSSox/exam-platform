import { defineConfig } from "vitest/config";

// The release workflow checks a content repository out into `exam-content/` inside the workspace;
// only this repository's own test folders may run, whatever that checkout contains.
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.{ts,tsx}", "apps/*/test/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "exam-content/**"],
  },
});
