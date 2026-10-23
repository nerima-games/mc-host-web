import { defineConfig, type ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/index.ts", "src/domain/**/*.ts"],
      exclude: [
        "**/*.d.ts",
        "**/*.config.ts",
        "**/*.test.ts",
        "**/*.spec.ts"
      ],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
});

export default config;
