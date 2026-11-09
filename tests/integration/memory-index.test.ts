import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresMemoryIndex,
  invalidateMemoryIndex,
  rebuildMemoryIndex,
} from "../../packages/db/src/memory-index";
import { retrieveGraphContext } from "../../packages/agent/src/graph-retrieval";
import type { MemoryEdge } from "../../packages/domain/src/memory-index";
describe.skipIf(
  !process.env.TEST_DATABASE_URL ||
    process.env.TEST_DATABASE_URL === process.env.DATABASE_URL,
)("derived PostgreSQL memory index", () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const ownerId = randomUUID(),
    foreignId = randomUUID();
  const at = "2026-10-30T00:00:00Z";
  const edge: MemoryEdge = {
    id: "e",
    namespace: "synthetic:graph",
    pointer: {
      ownerId,
      memoryId: "m",
      version: 1,
      sha256: "a".repeat(64),
      blobId: "b",
    },
    event: { provider: "kalshi", nativeId: "native", date: "2026-11-02" },
    entities: [{ kind: "team", provider: "nba", nativeId: "bos" }],
    relation: "condition",
    text: "official lineup",
    evidenceIds: ["source"],
    recordedAt: at,
    availableAt: at,
    validFrom: at,
    validTo: null,
    trusted: true,
  };
  const query = {
    ownerId,
    namespace: edge.namespace,
    event: edge.event,
    entities: edge.entities,
    query: "lineup",
    cutoffAt: at,
  };
  beforeAll(async () => {
    await pool.query(
      "INSERT INTO users(id,provider_subject) VALUES($1,$1),($2,$2)",
      [ownerId, foreignId],
    );
  });
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id=ANY($1::text[])", [
      [ownerId, foreignId],
    ]);
    await pool.end();
  });
  it("rebuilds atomically, deduplicates and enforces owner/event/time scope", async () => {
    await rebuildMemoryIndex(pool, {
      ownerId,
      namespace: edge.namespace,
      edges: [
        edge,
        edge,
        { ...edge, id: "future", recordedAt: "2026-11-01T00:00:00Z" },
        {
          ...edge,
          id: "other-date",
          event: { ...edge.event, date: "2026-11-03" },
        },
      ],
    });
    const search = createPostgresMemoryIndex(pool);
    expect((await search(query)).map((e) => e.id)).toEqual(["e"]);
    expect(await search({ ...query, ownerId: foreignId })).toEqual([]);
    await expect(
      rebuildMemoryIndex(pool, {
        ownerId,
        namespace: edge.namespace,
        edges: [{ ...edge, pointer: { ...edge.pointer, ownerId: foreignId } }],
      }),
    ).rejects.toThrow("OWNER_NAMESPACE");
    expect((await search(query)).map((e) => e.id)).toEqual(["e"]);
    const result = await retrieveGraphContext(query, {
      search,
      authorize: async () => true,
      readExact: async (p) => ({ pointer: p, text: "fresh verified bytes" }),
    });
    expect(result.items[0]?.text).toBe("fresh verified bytes");
    await rebuildMemoryIndex(pool, {
      ownerId,
      namespace: edge.namespace,
      edges: [edge],
    });
    expect(
      await invalidateMemoryIndex(pool, {
        ownerId,
        namespace: edge.namespace,
        memoryId: "m",
      }),
    ).toBe(1);
    expect(await search(query)).toEqual([]);
  });
});
