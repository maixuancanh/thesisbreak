import { expect, it } from "vitest";
import {
  researchFlags,
  pythonResearch,
} from "../../packages/integrations/src/research-jobs";
it("defaults research modules off", () =>
  expect(
    Object.values(researchFlags({})).every((v) => v === "off" || v === "false"),
  ).toBe(true));
it("rejects accidental active forecast mode", () =>
  expect(() =>
    researchFlags({ FORECAST_CHALLENGER_MODE: "active" }),
  ).toThrow());
it("bounds input before spawning a process", () =>
  expect(() =>
    pythonResearch({
      python: "never-run",
      cwd: ".",
      request: { text: "x".repeat(1_000_001) },
    }),
  ).toThrow("INPUT_LIMIT"));
