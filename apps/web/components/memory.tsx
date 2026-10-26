"use client";
import Link from "next/link";
import { useEffect, useState, useRef } from "react";
import { z } from "zod";
import { Button } from "./ui/button";
import { LessonReview } from "./lesson-review";
import { MemoryRecovery } from "./memory-recovery";
const records = z.object({
  data: z.array(
    z.object({
      lesson: z.object({
        id: z.string(),
        version: z.number(),
        rule: z.string(),
        scope: z.object({
          domain: z.string(),
          competition: z.string().optional(),
        }),
        status: z.string(),
      }),
      sync: z.object({
        state: z.string(),
        attempts: z.number(),
        receipt: z.unknown(),
      }),
    }),
  ),
});
type Row = z.infer<typeof records>["data"][number];
export function Memory() {
  const [rows, setRows] = useState<Row[] | null>(null),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0),
    [busy, setBusy] = useState(false);
  const receipt = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    const c = new AbortController();
    setError("");
    setRows(null);
    void fetch("/api/lessons", { cache: "no-store", signal: c.signal })
      .then(async (r) => {
        if (!r.ok)
          throw new Error(
            r.status === 401
              ? "Sign in to see your remembered preferences."
              : "Account memory is unavailable. Check your connection and try again.",
          );
        const data = records.parse(await r.json());
        if (!c.signal.aborted) setRows(data.data);
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(e instanceof Error ? e.message : "Memory unavailable.");
      });
    return () => c.abort();
  }, [reload]);
  async function change(row: Row, action: "paused" | "active" | "retired") {
    if (busy) return;
    setBusy(true);
    setError("");
    const key = JSON.stringify([row.lesson.id, row.lesson.version, action]);
    if (receipt.current?.key !== key)
      receipt.current = { key, id: crypto.randomUUID() };
    try {
      const r = await fetch(
        `/api/lessons/${encodeURIComponent(row.lesson.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: receipt.current.id,
            baseVersion: row.lesson.version,
            action,
            confirmed: true,
            ...(action === "active" ? { memoryConsent: true } : {}),
          }),
        },
      );
      if (!r.ok)
        throw new Error(
          r.status === 409
            ? "This preference changed. Refresh before trying again."
            : "Could not update your preference.",
        );
      receipt.current = null;
      setReload((x) => x + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main id="main" className="page narrow">
      <details className="panel">
        <summary>Storage & recovery</summary>
        <MemoryRecovery />
      </details>
      <div className="row">
        <div>
          <h1>What I remember</h1>
          <p className="lead">Your preferences. Your say.</p>
        </div>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setReload((x) => x + 1)}
        >
          Refresh
        </Button>
      </div>
      <p className="connection">
        Only approved preferences can guide future replies. Walrus storage is
        verified separately from saving to your account.
      </p>
      {error && (
        <div role="alert" className="connection">
          <p>{error}</p>
          <Link href="/account">Open Account</Link>
        </div>
      )}
      {rows === null ? (
        !error && <p role="status">Loading preferences…</p>
      ) : (
        <>
          <LessonReview onSaved={() => setReload((x) => x + 1)} />
          {!rows.length && (
            <p className="empty">
              No preferences yet. Add one above, or correct Thesis after a
              conversation.
            </p>
          )}
          {rows.map((row) => {
            const result = z
              .object({
                result: z
                  .object({ status: z.string(), blobId: z.string().optional() })
                  .optional(),
              })
              .safeParse(row.sync.receipt);
            const verified =
              row.sync.state === "done" &&
              result.success &&
              result.data.result?.status === "verified";
            return (
              <section className="panel" key={row.lesson.id}>
                <p className="eyebrow">
                  {row.lesson.scope.domain}
                  {row.lesson.scope.competition
                    ? ` · ${row.lesson.scope.competition}`
                    : ""}{" "}
                  · v{row.lesson.version}
                </p>
                <h2>{row.lesson.rule}</h2>
                <p>
                  {row.lesson.status === "active"
                    ? "Approved for future replies"
                    : row.lesson.status === "paused"
                      ? "Paused — excluded from future replies"
                      : "Retired — excluded from future replies"}
                </p>
                {row.lesson.status !== "retired" && (
                  <details>
                    <summary>Edit preference</summary>
                    <LessonReview
                      domain={row.lesson.scope.domain}
                      {...(row.lesson.scope.competition
                        ? { competition: row.lesson.scope.competition }
                        : {})}
                      existing={{
                        id: row.lesson.id,
                        version: row.lesson.version,
                        rule: row.lesson.rule,
                      }}
                      onSaved={() => setReload((x) => x + 1)}
                    />
                  </details>
                )}
                <p className="small muted">
                  {verified
                    ? "Walrus write and readback verified"
                    : row.sync.state === "not_requested"
                      ? "This version controls use in your account; no new remote write requested"
                      : row.sync.state === "blocked"
                        ? "Remote write stopped because this version is no longer eligible"
                        : row.sync.state === "retry"
                          ? "Walrus verification pending; the worker will retry"
                          : "Waiting for Walrus storage verification"}
                </p>
                {verified && result.success && result.data.result?.blobId && (
                  <details>
                    <summary>Storage receipt</summary>
                    <code className="memory-blob">
                      {result.data.result.blobId}
                    </code>
                  </details>
                )}
                <div className="row">
                  <Button
                    variant="outline"
                    disabled={busy || row.lesson.status === "retired"}
                    onClick={() =>
                      void change(
                        row,
                        row.lesson.status === "active" ? "paused" : "active",
                      )
                    }
                  >
                    {row.lesson.status === "active"
                      ? "Pause preference"
                      : "Use again & sync to Walrus"}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy || row.lesson.status === "retired"}
                    onClick={() => void change(row, "retired")}
                  >
                    Retire preference
                  </Button>
                </div>
              </section>
            );
          })}
        </>
      )}
    </main>
  );
}
