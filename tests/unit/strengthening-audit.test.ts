import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  cohortExportOptions,
  reportOutputPath,
  publicEvidenceUrl,
  writePrivateReport,
} from "../../packages/db/src/strengthening-audit";
it("creates a new private report and refuses to replace an existing report", async () => {
  const path = `.local/report-test-${randomUUID()}.json`;
  try {
    expect((await writePrivateReport(path, { readOnly: true })).sha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    await expect(writePrivateReport(path, { changed: true })).rejects.toThrow();
  } finally {
    await unlink(path).catch(() => {});
  }
});
it("requires explicit owner and one namespace/method/horizon; disallows synthetic mixing", () => {
  const good = {
    user: "owner",
    namespace: "live",
    method: "elo",
    horizon: "T24h",
  };
  expect(cohortExportOptions.parse(good).namespace).toBe("live");
  for (const patch of [
    { user: "" },
    { namespace: "synthetic" },
    { namespace: "*" },
    { horizon: "all" },
    { extra: true },
  ])
    expect(() => cohortExportOptions.parse({ ...good, ...patch })).toThrow();
});
it("limits report writes to .local and removes URL credentials/query/fragments", () => {
  expect(reportOutputPath(".local/cohort.json")).toMatch(/cohort.json$/);
  for (const p of [
    "report.json",
    ".local/../public.json",
    ".local",
    "../outside.json",
  ])
    expect(() => reportOutputPath(p)).toThrow("PRIVATE_REPORT_PATH_REQUIRED");
  expect(
    publicEvidenceUrl("https://user:secret@nba.com/result?token=SECRET#x"),
  ).toBe("https://nba.com/result");
});
