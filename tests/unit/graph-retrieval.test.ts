import { describe, expect, it } from "vitest";
import { retrieveGraphContext } from "../../packages/agent/src/graph-retrieval";
import {
  rankMemoryEdges,
  type MemoryEdge,
} from "../../packages/domain/src/memory-index";
const at = "2026-10-30T00:00:00Z";
const edge: MemoryEdge = {
  id: "e",
  namespace: "eval",
  pointer: {
    ownerId: "a",
    memoryId: "m",
    version: 1,
    sha256: "a".repeat(64),
    blobId: "blob",
  },
  event: { provider: "kalshi", nativeId: "game", date: "2026-11-02" },
  entities: [{ kind: "team", provider: "nba", nativeId: "bos" }],
  relation: "condition",
  text: "official lineup",
  evidenceIds: ["source-1"],
  recordedAt: at,
  availableAt: at,
  validFrom: at,
  validTo: null,
  trusted: true,
};
const query = {
  ownerId: "a",
  namespace: "eval",
  cutoffAt: at,
  event: edge.event,
  query: "lineup",
  entities: edge.entities,
};
describe("temporal graph pointers", () => {
  it("filters owner, exact event/date, trust and future edges before ranking", () => {
    const variants = [
      edge,
      { ...edge, id: "foreign", pointer: { ...edge.pointer, ownerId: "b" } },
      { ...edge, id: "date", event: { ...edge.event, date: "2026-11-03" } },
      { ...edge, id: "future", recordedAt: "2026-11-01T00:00:00Z" },
      { ...edge, id: "claim", trusted: false },
    ];
    expect(rankMemoryEdges(query, variants).map((e) => e.id)).toEqual(["e"]);
  });
  it("never emits index text and rechecks authority after exact readback", async () => {
    let checks = 0;
    const result = await retrieveGraphContext(query, {
      search: async () => [edge],
      authorize: async () => ++checks === 1,
      readExact: async () => ({
        pointer: edge.pointer,
        text: "verified content",
      }),
    });
    expect(result.items).toEqual([]);
    expect(checks).toBe(2);
  });
  it("rejects changed hash and reports outages separately from empty", async () => {
    const result = await retrieveGraphContext(query, {
      search: async () => [edge],
      authorize: async () => true,
      readExact: async () => ({
        pointer: { ...edge.pointer, sha256: "b".repeat(64) },
        text: "wrong",
      }),
    });
    expect(result.items).toEqual([]);
    expect(result.rejected[0]?.reason).toBe("readback_mismatch");
    expect(
      (
        await retrieveGraphContext(query, {
          search: async () => {
            throw Error();
          },
          authorize: async () => true,
          readExact: async () => null,
        })
      ).status,
    ).toBe("unavailable");
  });
  it("deduplicates pointers and bounds final context", async () => {
    const result = await retrieveGraphContext(
      { ...query, maxCharacters: 3 },
      {
        search: async () => [edge, { ...edge, id: "copy" }],
        authorize: async () => true,
        readExact: async () => ({
          pointer: edge.pointer,
          text: "long content",
        }),
      },
    );
    expect(result.items).toEqual([]);
  });
});
