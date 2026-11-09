"use client";
import { PagedList } from "./paged-list";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { z } from "zod";
import { Button } from "./ui/button";
const responseSchema = z.object({
  enabled: z.boolean(),
  data: z.array(
    z.object({
      id: z.string(),
      eventId: z.string(),
      url: z.string(),
      originId: z.string(),
      reason: z.string(),
      state: z.string(),
      expiresAt: z.string(),
      lastSuccessAt: z.string().nullable(),
      error: z.string().nullable(),
      changes: z.number(),
    }),
  ),
  changes: z.array(
    z.object({
      id: z.string(),
      watchId: z.string(),
      before: z.string(),
      after: z.string(),
      observedAt: z.string(),
    }),
  ),
});
type WatchPage = z.infer<typeof responseSchema>;
export function SourceWatchCard({
  eventId,
  eventEndAt,
}: {
  eventId?: string | undefined;
  eventEndAt?: string | null | undefined;
}) {
  const formId = useId();
  const [page, setPage] = useState<WatchPage | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    void fetch("/api/source-watches", { cache: "no-store", signal: c.signal })
      .then(async (r) => {
        if (!r.ok)
          throw Error(
            r.status === 401
              ? "Sign in to follow source updates."
              : "Source checks are unavailable. Last known state is retained.",
          );
        const data = responseSchema.parse(await r.json());
        if (!c.signal.aborted) {
          setPage(data);
          setError("");
        }
      })
      .catch((e: unknown) => {
        if (!c.signal.aborted)
          setError(
            e instanceof Error ? e.message : "Source checks unavailable.",
          );
      });
    return () => c.abort();
  }, [reload]);
  async function mutate(url: string, method: string, input: unknown) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!r.ok) {
        const result = (await r.json()) as { error?: string };
        throw Error(
          result.error === "SOURCE_URL_FORBIDDEN"
            ? "This publisher is not enabled for source monitoring."
            : result.error === "SOURCE_WATCH_DISABLED"
              ? "Source monitoring is currently paused by the service."
              : "Could not save this source watch. Check the fields and retry.",
        );
      }
      setReload((n) => n + 1);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not save this source watch.",
      );
    } finally {
      setBusy(false);
    }
  }
  const watches =
    page?.data.filter((w) => !eventId || w.eventId === eventId) ?? [];
  return (
    <section
      className="panel"
      aria-labelledby={`${formId}-title`}
      aria-busy={busy}
    >
      <h2 id={`${formId}-title`}>Follow source updates</h2>
      <p>
        Track an official source field and review changes before deciding what
        to do.
      </p>
      {error && <p role="alert">{error}</p>}
      {!page && !error && <p role="status">Loading source watches…</p>}
      <Button
        variant="ghost"
        disabled={busy}
        onClick={() => setReload((n) => n + 1)}
      >
        Refresh source watches
      </Button>
      {page && !page.enabled && (
        <p role="status">
          Source monitoring is disabled. Saved watches retain their last
          successful check.
        </p>
      )}
      {page && watches.length === 0 && (
        <p>
          No sources followed for {eventId ? "this event" : "your account"} yet.
        </p>
      )}
      <PagedList items={watches} label="Source watches" size={4}>
        {(w) => (
          <article key={w.id} className="panel">
            <h3>{w.originId}</h3>
            <p>{w.reason}</p>
            <a href={w.url} target="_blank" rel="noreferrer">
              Open tracked source
            </a>
            <p>
              {Date.parse(w.expiresAt) <= Date.now()
                ? "Expired"
                : w.state === "paused"
                  ? "Paused"
                  : !page?.enabled
                    ? "Service paused"
                    : "Following"}{" "}
              · Last successful check:{" "}
              {w.lastSuccessAt
                ? new Date(w.lastSuccessAt).toLocaleString()
                : "Not checked yet"}
            </p>
            {w.error && <p role="status">{w.error}</p>}
            <Button
              disabled={
                busy ||
                (w.state === "paused" &&
                  (!page?.enabled || Date.parse(w.expiresAt) <= Date.now()))
              }
              onClick={() =>
                void mutate(`/api/source-watches/${w.id}`, "PATCH", {
                  state: w.state === "paused" ? "active" : "paused",
                })
              }
            >
              {w.state === "paused" ? "Resume" : "Pause"}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void mutate(`/api/source-watches/${w.id}`, "PATCH", {
                  state: "deleted",
                })
              }
            >
              Stop following
            </Button>
            {page?.changes
              .filter((e) => e.watchId === w.id)
              .map((change) => (
                <div key={change.id}>
                  <h4>What changed</h4>
                  <p>Before: {change.before}</p>
                  <p>Now: {change.after}</p>
                  <p>
                    Why it matters: this source is tracked for “{w.reason}”.
                    Verify the update before changing your pick.
                  </p>
                  <Link href="/picks">Review my pick</Link>
                </div>
              ))}
          </article>
        )}
      </PagedList>
      {page?.enabled && (
        <details>
          <summary>Follow an official JSON source</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const fields = new FormData(e.currentTarget);
              void mutate("/api/source-watches", "POST", {
                eventId: eventId || String(fields.get("event")),
                eventEndAt:
                  eventEndAt ||
                  new Date(String(fields.get("end"))).toISOString(),
                url: String(fields.get("url")),
                originId: String(fields.get("origin")),
                contentClass: "json",
                selector: String(fields.get("field")),
                dependencyId: String(fields.get("reason")),
                hypothesisVersion: 1,
                pollSeconds: 300,
              });
            }}
          >
            {!eventId && (
              <label>
                Event identifier
                <input name="event" required maxLength={300} />
              </label>
            )}
            {!eventEndAt && (
              <label>
                Event end time
                <input name="end" type="datetime-local" required />
              </label>
            )}
            <label>
              Official source URL
              <input
                name="url"
                type="url"
                required
                maxLength={2000}
                placeholder="https://publisher.example/api/event"
              />
            </label>
            <label>
              Publisher name
              <input name="origin" required maxLength={300} />
            </label>
            <label>
              Field to follow
              <input
                name="field"
                required
                maxLength={500}
                pattern="/.*"
                placeholder="/lineup/status"
              />
            </label>
            <label>
              Reason tracked
              <input
                name="reason"
                required
                maxLength={300}
                placeholder="Official lineup status"
              />
            </label>
            <p>
              Only publishers enabled by the service can be followed. Checks run
              at most every five minutes and expire after the event.
            </p>
            <Button type="submit" disabled={busy}>
              Follow updates
            </Button>
          </form>
        </details>
      )}
    </section>
  );
}
