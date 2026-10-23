import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";

const config: PlaywrightTestConfig = defineConfig({
  testDir: "./",
  testMatch: "e2e/**/*.e2e.ts"
});

export default config;
