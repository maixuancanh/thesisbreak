import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  memoryBenchmarkCaseSchema,
  memoryRejection,
} from "../../packages/domain/src/memory-benchmark";
import {
  MemwalAdapter,
  type MemoryClient,
} from "../../packages/integrations/src/memwal";
import { conversationLogicalId } from "../../packages/db/src/chat-sessions";
import {
  createExactMemoryRecall,
  type memoryRecallManifestSchema,
} from "../../packages/agent/src/memory-evaluation-walrus";
import { runRuntimeAblations } from "../../packages/agent/src/runtime-ablation";
import type { z } from "zod";

const fixture = memoryBenchmarkCaseSchema.parse(
  JSON.parse(
    readFileSync("tests/fixtures/agent-memory/cases.jsonl", "utf8").split(
      "\n",
    )[0]!,
  ),
);
const pointer = fixture.memories.find(
  (item) => !memoryRejection(fixture, item),
)!;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function setup() {
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const payload = {
    sessionId,
    title: "Synthetic evaluation",
    turns: [
      {
        runId: "eval-run",
        platform: "kalshi",
        nativeId: fixture.marketId,
        question: fixture.query,
        user: pointer.text,
        reply: "",
        at: pointer.availableAt,
        evidenceRefs: [],
      },
    ],
  };
  const record = {
    logicalId: conversationLogicalId(payload),
    type: "conversation.session",
    version: 1,
    recordedAt: new Date(fixture.knownAt).toISOString(),
    payload,
  };
  const body = { schema: 1, userId: fixture.ownerId, ...record };
  const hash = createHash("sha256").update(canonical(body)).digest("hex");
  let remoteText = canonical({ ...body, hash });
  const recallSdk = vi.fn(async () => ({
    results: [{ text: remoteText, blob_id: "exact-blob", distance: 0.1 }],
    total: 1,
  }));
  const rememberAndWait = vi.fn(async () => {
    throw Error("WRITES_FORBIDDEN");
  });
  const client: MemoryClient = {
    recall: recallSdk,
    rememberAndWait,
    restore: async () => {
      throw Error("RESTORE_NOT_USED");
    },
    destroy: () => {},
  };
  const adapter = new MemwalAdapter(client, fixture.ownerId);
  const owned = {
    payload,
    hash,
    blob_id: "exact-blob",
    recorded_at: fixture.knownAt,
  };
  const query = vi.fn().mockResolvedValue({ rows: [owned] });
  const manifest: z.infer<typeof memoryRecallManifestSchema> = {
    purpose: "authorized_synthetic_memory_evaluation",
    records: [
      {
        fixtureId: fixture.id,
        namespace: fixture.namespace,
        pointer: structuredClone(pointer),
        sessionId,
        version: 1,
        walrusNamespace: adapter.namespace,
        blobId: owned.blob_id,
        hash,
      },
    ],
  };
  const recall = createExactMemoryRecall({
    pool: { query },
    manifest,
    adapterForOwner: () => adapter,
  });
  return {
    recall,
    query,
    owned,
    manifest,
    adapter,
    recallSdk,
    rememberAndWait,
    getText: () => remoteText,
    setText: (text: string) => {
      remoteText = text;
    },
  };
}

it("uses the actual MemwalAdapter fresh SDK boundary and exact authorized remote wording", async () => {
  const s = setup();
  expect(await s.recall(fixture)).toEqual([pointer]);
  expect(s.recallSdk).toHaveBeenCalledTimes(1);
  expect(s.query).toHaveBeenCalledTimes(2);
  expect(s.rememberAndWait).not.toHaveBeenCalled();
});

it.each(["before", "after"])(
  "rejects consent revocation %s remote recall",
  async (stage) => {
    const s = setup();
    s.query.mockReset();
    if (stage === "after") s.query.mockResolvedValueOnce({ rows: [s.owned] });
    s.query.mockResolvedValue({ rows: [] });
    await expect(s.recall(fixture)).rejects.toThrow(
      stage === "before"
        ? "CURRENT_AUTHORIZED_RECEIPT_REQUIRED"
        : "AUTHORITY_CHANGED_DURING_RECALL",
    );
    expect(s.recallSdk).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
  },
);

it("rejects mismatched DB and SDK hashes without using the local pointer as fallback", async () => {
  const s = setup();
  s.query.mockResolvedValueOnce({
    rows: [{ ...s.owned, hash: "b".repeat(64) }],
  });
  await expect(s.recall(fixture)).rejects.toThrow(
    "CURRENT_AUTHORIZED_RECEIPT_REQUIRED",
  );
  expect(s.recallSdk).not.toHaveBeenCalled();
  s.setText(
    JSON.stringify({ ...JSON.parse(s.getText()), hash: "b".repeat(64) }),
  );
  await expect(s.recall(fixture)).rejects.toThrow(
    "EXACT_REMOTE_BYTES_REQUIRED",
  );
});

it("rejects pointer version/text/owner/namespace substitutions before a DB or SDK read", async () => {
  for (const field of ["version", "text", "ownerId", "namespace"] as const) {
    const s = setup();
    const entry = s.manifest.records[0]!;
    if (field === "version") entry.pointer.version++;
    else if (field === "namespace") entry.namespace = "eval:other";
    else entry.pointer[field] = "production-owner-or-modified-text";
    const recall = createExactMemoryRecall({
      pool: { query: s.query },
      manifest: s.manifest,
      adapterForOwner: () => s.adapter,
    });
    await expect(recall(fixture)).rejects.toThrow(
      "EVALUATION_POINTER_OWNER_NAMESPACE_VERSION_TEXT_MISMATCH",
    );
    expect(s.query).not.toHaveBeenCalled();
    expect(s.recallSdk).not.toHaveBeenCalled();
  }
});

it("retains all failed memory arms while the no-memory control performs no recall", async () => {
  const s = setup();
  s.setText("unavailable");
  const report = await runRuntimeAblations({
    fixture,
    seed: "exact-failure",
    modelVersion: "injected",
    plan: async () => ({ tools: [] }),
    generate: async () => ({
      message: "Unknown",
      evidenceRefs: [],
      lessonRefs: [],
      proposedPick: null,
      proposedChange: null,
    }),
    recall: () => s.recall(fixture),
    memoryTransport: "fresh_verified_walrus",
    onTrace: async () => {},
  });
  expect(report.attempts).toBe(4);
  expect(report.failures).toBe(3);
  expect(s.recallSdk).toHaveBeenCalledTimes(3);
  expect(
    report.traces.find((trace) => trace.arm === "no_memory")?.failure,
  ).toBeNull();
  expect(report.traces.every((trace) => trace.retrieved.length === 0)).toBe(
    true,
  );
  expect(s.rememberAndWait).not.toHaveBeenCalled();
});
