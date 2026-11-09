import type { Pool } from "pg";
import type { MemoryEnvelope, MemoryRecord } from "./memwal";
import {
  researchMemoryBytes,
  researchMemoryHash,
} from "../../domain/src/research-memory-version";
import {
  assertResearchArtifactAuthority,
  claimResearchArtifactMemory,
  finishResearchArtifactMemory,
  loadResearchArtifactMemory,
  markResearchArtifactFreshRead,
  prepareNextResearchArtifactMemory,
  nextResearchArtifactMemoryIdentity,
  type ResearchArtifactClaim,
} from "../../db/src/research-artifact-memory";
export interface ResearchArtifactMemoryAdapter {
  remember(
    record: MemoryRecord,
  ): Promise<{ status: string; hash?: string; blobId?: string }>;
  recall(query: string): Promise<{
    sources: { record: MemoryEnvelope; blobId: string; text: string }[];
    conflicts: string[];
    conflictingBlobs: string[];
  }>;
  destroy(): void;
}
/** Fresh read requires exact retained UTF-8 bytes and receipt blob, not an index/DB copy. */
export async function verifyResearchArtifactMemory(
  c: ResearchArtifactClaim,
  deps: {
    assertAuthority: () => Promise<void>;
    recall: ResearchArtifactMemoryAdapter["recall"];
  },
) {
  try {
    await deps.assertAuthority();
    const bytes = researchMemoryBytes(c.ownerId, c.record),
      hash = researchMemoryHash(c.ownerId, c.record);
    if (!c.receipt || c.receipt.hash !== hash || c.recordHash !== hash)
      throw Error("RECEIPT_REQUIRED");
    const r = await deps.recall(bytes);
    await deps.assertAuthority();
    if (
      r.conflicts.includes(`${c.record.logicalId}@${c.record.version}`) ||
      r.conflictingBlobs.includes(c.receipt.blobId) ||
      !r.sources.some(
        (s) =>
          s.blobId === c.receipt!.blobId &&
          s.text === bytes &&
          s.record.hash === hash,
      )
    )
      throw Error("EXACT_REMOTE_BYTES_REQUIRED");
    return { status: "verified" as const, ...c.receipt };
  } catch {
    return {
      status: "blocked" as const,
      reason: "research_artifact_fresh_read_or_authority_unverified",
    };
  }
}
/** One explicit publication at most. Factory is invoked after current consent and destroyed on every path. */
export async function runResearchArtifactMemoryOnce(
  pool: Pool,
  input: {
    id: string;
    ownerId: string;
    reviewerId: string;
    enabled: boolean;
    createAdapter: () => ResearchArtifactMemoryAdapter;
  },
) {
  if (!input.enabled) return { checked: 0, verified: 0, disabled: true };
  const c = await claimResearchArtifactMemory(pool, input);
  if (!c) return { checked: 0, verified: 0 };
  let adapter: ResearchArtifactMemoryAdapter | undefined;
  try {
    await assertResearchArtifactAuthority(pool, c);
    adapter = input.createAdapter();
    const result = await adapter.remember(c.record);
    await assertResearchArtifactAuthority(pool, c);
    const saved = await finishResearchArtifactMemory(pool, c, result);
    return { checked: 1, verified: saved ? 1 : 0 };
  } catch {
    await finishResearchArtifactMemory(pool, c, { status: "blocked" });
    return { checked: 1, verified: 0 };
  } finally {
    adapter?.destroy();
  }
}
/** Each invocation constructs a new SDK. Only verified evidence may supply the mandatory checks. */
export async function recallResearchArtifactForPlanning(
  pool: Pool,
  input: {
    id: string;
    ownerId: string;
    reviewerId: string;
    createAdapter: () => ResearchArtifactMemoryAdapter;
  },
) {
  const c = await loadResearchArtifactMemory(pool, input);
  let adapter: ResearchArtifactMemoryAdapter | undefined;
  try {
    await assertResearchArtifactAuthority(pool, c);
    adapter = input.createAdapter();
    const proof = await verifyResearchArtifactMemory(c, {
      assertAuthority: () => assertResearchArtifactAuthority(pool, c),
      recall: (q) => adapter!.recall(q),
    });
    if (
      proof.status !== "verified" ||
      !(await markResearchArtifactFreshRead(pool, c))
    )
      return { status: "blocked" as const, checks: [], evidence: [] };
    const check = {
      source_change: "recheck_changed_source_dependency",
      forecast_rationale: "compare_original_forecast_evidence",
      forecast_result: "check_official_result_revision",
      drift_summary: "inspect_drift_before_using_calibration",
      decision_recap: "compare_reason_condition_and_official_result",
      accountability_review: "recheck_disputed_claim_dependencies",
    }[c.kind];
    return {
      status: "verified" as const,
      record: c.record,
      checks: [check],
      evidence: [
        {
          logicalId: c.record.logicalId,
          version: c.record.version,
          hash: proof.hash,
          blobId: proof.blobId,
          check,
          causalBenefit: "not_measured" as const,
        },
      ],
    };
  } finally {
    adapter?.destroy();
  }
}

/** Maintenance entry: local preparation is independent; this function has at most one remote sync. */
export async function maintainResearchArtifactMemory(
  pool: Pool,
  input: {
    enabled: boolean;
    allowRemoteSync: boolean;
    createAdapter: (ownerId: string) => ResearchArtifactMemoryAdapter;
  },
) {
  if (!input.enabled)
    return { prepared: 0, checked: 0, verified: 0, disabled: true };
  const prepared = await prepareNextResearchArtifactMemory(pool);
  if (!input.allowRemoteSync) return { ...prepared, checked: 0, verified: 0 };
  const identity = await nextResearchArtifactMemoryIdentity(pool);
  if (!identity) return { ...prepared, checked: 0, verified: 0 };
  try {
    return {
      ...prepared,
      ...(await runResearchArtifactMemoryOnce(pool, {
        ...identity,
        enabled: true,
        createAdapter: () => input.createAdapter(identity.ownerId),
      })),
    };
  } catch {
    return { ...prepared, checked: 1, verified: 0 };
  }
}
