"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "./ui/button";
import { WatchPick } from "./watch-pick";
import { liveMarketPath, livePlatform, friendlyDate } from "../lib/live-market";
const records = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      platform: livePlatform,
      native_id: z.string(),
      question: z.string().nullable(),
      event_title: z.string().nullable().optional(),
      catalog_provider: z
        .enum(["tatum", "kalshi-public", "polymarket-public"])
        .nullable()
        .optional(),
      outcome: z.string(),
      reason: z.string(),
      state: z.string(),
      current_version: z.number(),
      created_at: z.string(),
    }),
  ),
});
export function AccountPicks() {
  const [rows, setRows] = useState<z.infer<typeof records>["data"] | null>(
    null,
  );
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    setRows(null);
    setError("");
    void fetch("/api/picks", { signal: c.signal, cache: "no-store" })
      .then(async (r) => {
        if (!r.ok)
          throw new Error(
            r.status === 401
              ? "Sign in to see your account picks."
              : "Account picks are unavailable. Try again later.",
          );
        setRows(records.parse(await r.json()).data);
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(e instanceof Error ? e.message : "Picks unavailable.");
      });
    return () => c.abort();
  }, [reload]);
  return (
    <main id="main" className="page">
      <div className="row">
        <div>
          <h1>My picks</h1>
          <p className="lead">Your saved views and reasons.</p>
        </div>
        <Button asChild>
          <Link href="/">Add a pick</Link>
        </Button>
      </div>
      {error ? (
        <div className="connection" role="alert">
          <p>{error}</p>
          <Link className="text-link" href="/account">
            Open Account
          </Link>{" "}
          <Button variant="outline" onClick={() => setReload((x) => x + 1)}>
            Retry
          </Button>
        </div>
      ) : !rows ? (
        <p role="status">Loading account picks...</p>
      ) : !rows.length ? (
        <div className="empty">
          <h2>Start with one considered pick</h2>
          <Link className="text-link" href="/">
            Browse live markets
          </Link>
        </div>
      ) : (
        <div className="grid">
          {rows.map((p) => (
            <article className="event-card saved-event-card" key={p.id}>
              <p className="small muted">{p.platform} · Saved</p>
              {p.event_title && (
                <p className="saved-event-title">{p.event_title}</p>
              )}
              <h2>
                <Link
                  href={liveMarketPath(
                    {
                      platform: p.platform,
                      id: p.native_id,
                    },
                    p.catalog_provider ?? undefined,
                  )}
                >
                  {p.question ?? p.native_id}
                </Link>
              </h2>
              <strong>Your view: {p.outcome}</strong>
              <p className="saved-reason" style={{ whiteSpace: "pre-wrap" }}>
                {p.reason || "No reason recorded."}
              </p>
              <p className="small muted">Saved {friendlyDate(p.created_at)}</p>
              <WatchPick pickId={p.id} version={p.current_version} />
              <Link
                className="text-link"
                href={liveMarketPath(
                  { platform: p.platform, id: p.native_id },
                  p.catalog_provider ?? undefined,
                )}
              >
                Open live market
              </Link>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
