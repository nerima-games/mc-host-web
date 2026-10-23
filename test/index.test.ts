import { expect, test } from "vitest";
import { hostRuntimeKind } from "../src/index.js";

test("hostRuntimeKind identifies the browser runtime", () => {
  expect(hostRuntimeKind).toBe("browser");
});
