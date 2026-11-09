import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createConfiguredMemoryIndex,
  syncGraphitiMemoryIndex,
  graphitiBridgeConfig,
} from "../../packages/integrations/src/graphiti-bridge";
const at = "2026-10-30T00:00:00Z";
const query = {
  ownerId: "owner",
  namespace: "owner:approved-lessons",
  event: { provider: "kalshi", nativeId: "game", date: "2026-11-02" },
  cutoffAt: at,
  query: "lineup",
  entities: [],
};
const edge = {
  id: "e",
  namespace: query.namespace,
  pointer: {
    ownerId: "owner",
    memoryId: "m",
    version: 1,
    sha256: "a".repeat(64),
    blobId: "b",
  },
  event: query.event,
  entities: [],
  relation: "condition",
  text: "official lineup",
  evidenceIds: ["source"],
  recordedAt: at,
  availableAt: at,
  validFrom: at,
  validTo: null,
  trusted: true,
};
const env = {
  GRAPHITI_SEARCH_ENABLED: "true",
  GRAPHITI_INGEST_ENABLED: "true",
  GRAPHITI_OWNER_IDS: "owner",
  GRAPHITI_PYTHON_PATH: "C:/trusted/python.exe",
  GRAPHITI_DATABASE_URI: "bolt://127.0.0.1:7687",
  GRAPHITI_DATABASE_HOSTS: "127.0.0.1",
  GRAPHITI_DATABASE_USER: "neo4j",
  GRAPHITI_DATABASE_PASSWORD: "test-only",
};
describe("configured Graphiti app bridge", () => {
  it("defaults off and rejects foreign owners, unallowlisted destinations and insecure remote transport", () => {
    expect(graphitiBridgeConfig({}, "owner", "search")).toBeNull();
    expect(graphitiBridgeConfig(env, "foreign", "search")).toBeNull();
    expect(() =>
      graphitiBridgeConfig(
        { ...env, GRAPHITI_DATABASE_HOSTS: "other" },
        "owner",
        "search",
      ),
    ).toThrow();
    expect(() =>
      graphitiBridgeConfig(
        {
          ...env,
          GRAPHITI_DATABASE_URI: "bolt://remote.example",
          GRAPHITI_DATABASE_HOSTS: "remote.example",
        },
        "owner",
        "search",
      ),
    ).toThrow();
  });
  it("uses scoped Postgres fallback when off or the external graph is down", async () => {
    const queryDb = vi.fn().mockResolvedValue({ rows: [{ edge }] });
    const execute = vi.fn().mockRejectedValue(Error("private backend details"));
    const pool = { query: queryDb } as unknown as Pool;
    expect(
      await createConfiguredMemoryIndex(pool, { env: {}, execute })(query),
    ).toEqual([edge]);
    expect(execute).not.toHaveBeenCalled();
    expect(
      await createConfiguredMemoryIndex(pool, { env, execute })(query),
    ).toEqual([edge]);
    expect(queryDb).toHaveBeenCalledTimes(2);
  });
  it("revalidates graph candidates for owner, event, provenance and cutoff before exposing pointers", async () => {
    const queryDb = vi.fn().mockResolvedValue({ rows: [] });
    const execute = vi
      .fn()
      .mockResolvedValue({
        status: "ok",
        mode: "lexical_entity",
        requiresRemoteReadback: true,
        items: [
          edge,
          { ...edge, pointer: { ...edge.pointer, ownerId: "foreign" } },
          { ...edge, id: "future", availableAt: "2026-11-01T00:00:00Z" },
          {
            ...edge,
            id: "different-date",
            event: { ...edge.event, date: "2026-11-03" },
          },
        ],
      });
    expect(
      await createConfiguredMemoryIndex({ query: queryDb } as unknown as Pool, {
        env,
        execute,
      })(query),
    ).toEqual([edge]);
    expect(queryDb).not.toHaveBeenCalled();
    expect(execute.mock.calls[0]?.[0]).toEqual({
      operation: "search",
      payload: query,
    });
  });
  it("materializes only the exact local reviewed index and sends empty replacement to invalidate stale remote edges", async () => {
    const queryDb = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ edge }] })
      .mockResolvedValueOnce({ rows: [] });
    const execute = vi
      .fn()
      .mockResolvedValue({ status: "ok", indexed: 1, mode: "lexical_entity" });
    const pool = { query: queryDb } as unknown as Pool;
    expect(
      (
        await syncGraphitiMemoryIndex(pool, "owner", query.namespace, {
          env,
          execute,
        })
      ).status,
    ).toBe("ok");
    expect(execute.mock.calls[0]?.[0]).toEqual({
      operation: "ingest",
      payload: { ownerId: "owner", namespace: query.namespace, edges: [edge] },
    });
    await syncGraphitiMemoryIndex(pool, "owner", query.namespace, {
      env,
      execute,
    });
    expect(execute.mock.calls[1]?.[0]).toEqual({
      operation: "ingest",
      payload: { ownerId: "owner", namespace: query.namespace, edges: [] },
    });
  });
});
