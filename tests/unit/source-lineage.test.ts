import { describe, it, expect } from "vitest";
import {
  groupVerifiedOrigins,
  normalizeReportUrl,
} from "../../packages/agent/src/source-lineage";
const evidence = [
  { id: "a", claimId: "claim", eventId: "event" },
  { id: "b", claimId: "claim", eventId: "event" },
  { id: "c", claimId: "claim", eventId: "different" },
];
const edge = {
  id: "edge",
  fromEvidenceId: "a",
  toEvidenceId: "b",
  relation: "explicit_citation" as const,
  verification: "verified" as const,
  supportRef: "a",
  supportHash: "a".repeat(64),
  version: 1,
};
describe("verified report families", () => {
  it("merges verified report relationships with cycle safety and exact event scope", () => {
    const result = groupVerifiedOrigins(evidence, [
      edge,
      { ...edge, id: "reverse", fromEvidenceId: "b", toEvidenceId: "a" },
      { ...edge, id: "other", toEvidenceId: "c" },
    ]);
    expect(result.families).toHaveLength(2);
    expect(result.families.find((f) => f.id === "a")?.evidenceIds).toEqual([
      "a",
      "b",
    ]);
    expect(result.unknownCount).toBe(1);
  });
  it("candidate/similar origins never establish independence", () => {
    expect(
      groupVerifiedOrigins(evidence, [{ ...edge, verification: "candidate" }])
        .families,
    ).toHaveLength(3);
    expect(groupVerifiedOrigins(evidence, []).confirmedIndependentCount).toBe(
      0,
    );
  });
  it("preserves report-defining queries and strips only tracking", () => {
    expect(
      normalizeReportUrl(
        "https://news.test/article?id=123&utm_source=x#section",
      ),
    ).toBe("https://news.test/article?id=123");
  });
});
