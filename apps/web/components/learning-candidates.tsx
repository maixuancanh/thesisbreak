"use client";
import { PagedList } from "./paged-list";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { candidateSchema } from "../../../packages/domain/src/experience-learning";
import { Button } from "./ui/button";
const rowsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      version: z.number(),
      status: z.string(),
      payload: candidateSchema,
      consolidation: z
        .object({
          classification: z.enum([
            "new",
            "reinforcement",
            "conflict",
            "scope_change",
            "no_increment",
          ]),
          relatedId: z.string().nullable().optional(),
          relatedVersion: z.number().nullable().optional(),
          requiresReview: z.boolean(),
        })
        .nullable()
        .optional(),
      sync_state: z.string().nullable().optional(),
      sync_receipt: z
        .object({ result: z.object({ status: z.string() }).optional() })
        .passthrough()
        .nullable()
        .optional(),
    }),
  ),
});
type Candidate = z.infer<typeof rowsSchema>["data"][number];
export function LearningCandidates({ onSaved }: { onSaved?: () => void }) {
  const [rows, setRows] = useState<Candidate[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0),
    [editing, setEditing] = useState<string | null>(null),
    [draft, setDraft] = useState(""),
    [consent, setConsent] = useState<string | null>(null),
    [acknowledged, setAcknowledged] = useState<string | null>(null);
  const receipt = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    const c = new AbortController();
    void fetch("/api/learning/candidates", {
      cache: "no-store",
      signal: c.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw Error("Could not load new lessons. Try refreshing.");
        return rowsSchema.parse(await r.json());
      })
      .then((r) => {
        setRows(r.data);
        setError("");
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(e instanceof Error ? e.message : "Lessons unavailable.");
      });
    return () => c.abort();
  }, [reload]);
  async function act(row: Candidate, action: "approve" | "reject" | "edit") {
    if (
      busy ||
      (action === "approve" && consent !== `${row.id}:${row.version}`) ||
      (action === "approve" &&
        ["conflict", "scope_change"].includes(
          row.consolidation?.classification ?? "",
        ) &&
        acknowledged !== `${row.id}:${row.version}`)
    )
      return;
    const payload = {
      baseVersion: row.version,
      action,
      confirmed: true,
      ...(action === "approve" ? { memoryConsent: true } : {}),
      ...(action === "approve" &&
      ["conflict", "scope_change"].includes(
        row.consolidation?.classification ?? "",
      )
        ? { acknowledgeConflict: true }
        : {}),
      ...(action === "edit"
        ? {
            statement: draft.trim(),
            scope: row.payload.scope,
            condition: row.payload.condition,
          }
        : {}),
    };
    const key = JSON.stringify([row.id, payload]);
    if (receipt.current?.key !== key)
      receipt.current = { key, id: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const r = await fetch(
        `/api/learning/candidates/${encodeURIComponent(row.id)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, requestId: receipt.current.id }),
        },
      );
      if (!r.ok)
        throw Error(
          r.status === 409
            ? "This lesson or its evidence changed. Refresh before reviewing it again."
            : "Could not save your review. Your changes are kept.",
        );
      receipt.current = null;
      setEditing(null);
      setConsent(null);
      setAcknowledged(null);
      setReload((x) => x + 1);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Review unavailable.");
    } finally {
      setBusy(false);
    }
  }
  const pending = rows.filter((r) => r.status === "pending_review");
  return (
    <section
      className="panel lesson-review"
      aria-label="Lessons from your conversations"
    >
      <h2>What I learned</h2>
      <p className="small muted">
        Ideas from your recent conversations. Review a lesson before Thesis uses
        it next time.
      </p>
      {error && (
        <p role="alert">
          {error}{" "}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setReload((x) => x + 1)}
          >
            Refresh
          </Button>
        </p>
      )}
      {!pending.length && !error && <p>No new lessons to review yet.</p>}
      <PagedList items={pending} label="Suggested preferences" size={4}>
        {(row) => (
          <article className="panel" key={`${row.id}:${row.version}`}>
            <p>
              <strong>{row.payload.statement}</strong>
            </p>
            <p className="small muted">
              Applies to{" "}
              {row.payload.scope.competition ?? row.payload.scope.domain}
              {row.payload.scope.eventId ? " · this event" : ""}
            </p>
            <details>
              <summary>Why I suggested this</summary>
              {row.consolidation && (
                <p>
                  {
                    {
                      new: "New lesson",
                      reinforcement: "Adds support to a previous lesson",
                      conflict: "Conflicts with a previous lesson",
                      scope_change: "Changes when a previous lesson applies",
                      no_increment: "Repeats existing evidence",
                    }[row.consolidation.classification]
                  }
                  {row.consolidation.relatedVersion
                    ? ` · related version ${row.consolidation.relatedVersion}`
                    : ""}
                  .
                </p>
              )}
              {row.payload.evidence.map((e, i) => (
                <blockquote key={i}>
                  <p>{e.quote}</p>
                  <small>
                    {e.stance === "support"
                      ? "Supporting experience"
                      : "Contradicting experience"}
                  </small>
                </blockquote>
              ))}
            </details>
            {editing === row.id && (
              <label>
                Lesson
                <textarea
                  maxLength={2000}
                  value={draft}
                  disabled={busy}
                  onChange={(e) => setDraft(e.target.value)}
                />
              </label>
            )}
            {row.payload.kind !== "forecast_hypothesis" && (
              <label>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={consent === `${row.id}:${row.version}`}
                  onChange={(e) =>
                    setConsent(
                      e.target.checked ? `${row.id}:${row.version}` : null,
                    )
                  }
                />{" "}
                Remember this lesson with Walrus and use it in future research.
              </label>
            )}
            {["conflict", "scope_change"].includes(
              row.consolidation?.classification ?? "",
            ) && (
              <label>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={acknowledged === `${row.id}:${row.version}`}
                  onChange={(e) =>
                    setAcknowledged(
                      e.target.checked ? `${row.id}:${row.version}` : null,
                    )
                  }
                />{" "}
                I reviewed the disagreement or scope change and want to approve
                this version.
              </label>
            )}
            <div className="row">
              {editing === row.id ? (
                <Button
                  disabled={busy || !draft.trim()}
                  onClick={() => void act(row, "edit")}
                >
                  Save for review
                </Button>
              ) : (
                <>
                  {row.payload.kind !== "forecast_hypothesis" && (
                    <Button
                      disabled={
                        busy ||
                        consent !== `${row.id}:${row.version}` ||
                        (["conflict", "scope_change"].includes(
                          row.consolidation?.classification ?? "",
                        ) &&
                          acknowledged !== `${row.id}:${row.version}`)
                      }
                      onClick={() => void act(row, "approve")}
                    >
                      Approve lesson
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setEditing(row.id);
                      setDraft(row.payload.statement);
                    }}
                  >
                    Edit
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void act(row, "reject")}
              >
                Dismiss
              </Button>
            </div>
          </article>
        )}
      </PagedList>
      {rows
        .filter((r) => r.status === "approved")
        .map((row) => (
          <article key={`${row.id}:${row.version}`} className="panel">
            <p>{row.payload.statement}</p>
            <p role="status" className="small muted">
              {row.sync_state === "done" &&
              row.sync_receipt?.result?.status === "verified"
                ? "Verified in Walrus Memory"
                : row.sync_state === "failed" || row.sync_state === "retry"
                  ? "Memory sync needs another attempt. Your approved lesson is kept."
                  : "Approved · waiting for Walrus verification"}
            </p>
          </article>
        ))}
    </section>
  );
}
