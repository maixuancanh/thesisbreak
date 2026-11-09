"use client";
import { PagedList } from "./paged-list";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "./ui/button";
const kind = z.enum([
  "source_change",
  "forecast_rationale",
  "forecast_result",
  "drift_summary",
  "decision_recap",
  "accountability_review",
]);
const listing = z.object({
  candidates: z.array(z.object({ kind, artifact_id: z.string() })),
  grants: z.array(
    z.object({
      id: z.string(),
      kind,
      artifact_id: z.string(),
      snapshot_hash: z.string(),
      revoked_at: z.string().nullable(),
      state: z.string().nullable(),
      receipt: z.unknown(),
    }),
  ),
});
const inspection = z.object({
  inspectionId: z.string(),
  snapshotHash: z.string(),
  kind,
  artifactId: z.string(),
  snapshot: z.record(z.string(), z.unknown()),
});
type Listing = z.infer<typeof listing>;
type Inspection = z.infer<typeof inspection>;
const labels = {
  source_change: "Source change",
  forecast_rationale: "Original forecast reasoning",
  forecast_result: "Official forecast result",
  drift_summary: "Drift summary",
  decision_recap: "Decision recap",
  accountability_review: "Claim corrections and review history",
};
export function ResearchArtifactConsent() {
  const [data, setData] = useState<Listing | null>(null),
    [view, setView] = useState<Inspection | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    void fetch("/api/memory/artifacts", { cache: "no-store", signal: c.signal })
      .then(async (r) => {
        if (!r.ok)
          throw Error(
            r.status === 401
              ? "Sign in to manage research memory."
              : "Research memory is unavailable.",
          );
        const parsed = listing.parse(await r.json());
        if (!c.signal.aborted) setData(parsed);
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(
            e instanceof Error ? e.message : "Research memory is unavailable.",
          );
      });
    return () => c.abort();
  }, [reload]);
  async function act(body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/memory/artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok)
        throw Error(
          r.status === 409
            ? "This review expired or the evidence changed. Inspect it again before saving."
            : "Could not update research memory. Try again.",
        );
      if (body.action === "inspect") {
        setView(inspection.parse(await r.json()));
        setConfirmed(false);
      } else {
        setView(null);
        setConfirmed(false);
        setReload((x) => x + 1);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-labelledby="research-artifact-title">
      <div className="row">
        <h2 id="research-artifact-title">Research memory</h2>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setError("");
            setReload((x) => x + 1);
          }}
        >
          Refresh research memory
        </Button>
      </div>
      <p>
        Review the exact evidence before saving it for future research. Each
        permission covers one snapshot.
      </p>
      {error && <p role="alert">{error}</p>}
      {data && !data.candidates.length && (
        <p className="muted">No eligible research artifacts yet.</p>
      )}
      <PagedList
        items={data?.candidates ?? []}
        label="Research to remember"
        size={4}
      >
        {(c) => (
          <div className="row" key={`${c.kind}:${c.artifact_id}`}>
            <span>
              {labels[c.kind]} <small>{c.artifact_id}</small>
            </span>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act({
                  action: "inspect",
                  kind: c.kind,
                  artifactId: c.artifact_id,
                })
              }
            >
              Inspect evidence
            </Button>
          </div>
        )}
      </PagedList>
      {view && (
        <div className="panel">
          <h3>{labels[view.kind]}</h3>
          <p>
            Snapshot hash:{" "}
            <code className="memory-blob">{view.snapshotHash}</code>
          </p>
          <pre
            className="memory-blob"
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              maxHeight: 320,
              overflow: "auto",
            }}
          >
            {JSON.stringify(view.snapshot, null, 2)}
          </pre>
          <p>
            Saving authorizes this evidence to be uploaded to Walrus storage and
            recalled for your research. Uploaded copies may remain after you
            revoke permission. Revoking stops future use in Thesis. This does
            not approve any global research procedure.
          </p>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{" "}
            I reviewed this snapshot and consent to storing and recalling it.
          </label>
          <div className="row">
            <Button
              disabled={busy || !confirmed}
              onClick={() =>
                void act({
                  action: "grant",
                  inspectionId: view.inspectionId,
                  snapshotHash: view.snapshotHash,
                  confirmed: true,
                })
              }
            >
              Save this snapshot
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setView(null);
                setConfirmed(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      <PagedList items={data?.grants ?? []} label="Saved research" size={4}>
        {(g) => (
          <div className="panel" key={g.id}>
            <h3>{labels[g.kind]}</h3>
            <p className="small muted">
              {g.revoked_at
                ? "Permission revoked — future use blocked"
                : g.state === "verified"
                  ? "Storage verified"
                  : g.state === "blocked"
                    ? "Sync blocked — inspect current evidence to try again"
                    : "Permission saved — awaiting storage verification"}
            </p>
            <code className="memory-blob">{g.snapshot_hash}</code>
            {!g.revoked_at && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void act({ action: "revoke", grantId: g.id })}
              >
                Revoke permission
              </Button>
            )}
          </div>
        )}
      </PagedList>
    </section>
  );
}
