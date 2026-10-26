"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { ContextualThesis } from "./contextual-thesis";
import { conditionTitle } from "../lib/event-presentation";
import { cn } from "../lib/utils";
import {
  fetchLivePage,
  friendlyDate,
  outcomePrice,
  providerLabel,
  type LivePage,
  type LivePlatform,
  type LiveProvider,
} from "../lib/live-market";
export function LiveMarketDetail({
  platform,
  id,
  provider,
}: {
  platform: LivePlatform;
  id: string;
  provider?: LiveProvider | undefined;
}) {
  const [page, setPage] = useState<LivePage | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [mobile, setMobile] = useState("Market");
  const [outcome, setOutcome] = useState("");
  const [selection, setSelection] = useState(0);
  const positions = useRef<Record<string, number>>({ Market: 0, Thesis: 0 });
  function switchPane(next: string) {
    if (window.matchMedia("(min-width: 761px)").matches) return;
    positions.current[mobile] = window.scrollY;
    setMobile(next);
    requestAnimationFrame(() =>
      window.scrollTo({
        top: positions.current[next] ?? 0,
        behavior: "instant",
      }),
    );
  }
  useEffect(() => {
    const c = new AbortController();
    setPage(null);
    setError("");
    setOutcome("");
    const query = new URLSearchParams({ platform, id });
    if (provider) query.set("provider", provider);
    void fetchLivePage(query, c.signal)
      .then((result) => {
        if (!c.signal.aborted) setPage(result);
      })
      .catch((cause) => {
        if (!c.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : "Market unavailable.",
          );
      });
    return () => c.abort();
  }, [platform, id, provider, reload]);
  const market = page?.data.find((m) => m.platform === platform && m.id === id);
  const source = page?.provider === "tatum" ? "tatum" : "public";
  return (
    <main id="main" className="discover-v7 live-detail">
      <div className="mobile-switch" aria-label="Market view">
        {["Market", "Thesis"].map((t) => (
          <Button
            key={t}
            aria-pressed={mobile === t}
            onClick={() => switchPane(t)}
          >
            {t}
          </Button>
        ))}
      </div>
      <div className="discover-layout">
        <section
          className={cn(
            "discovery-feed",
            mobile !== "Market" && "mobile-hidden",
          )}
        >
          <Link className="text-link" href="/">
            ← Discover
          </Link>
          {error && (
            <div className="connection" role="alert">
              {error}
              <Button onClick={() => setReload((x) => x + 1)}>Retry</Button>
            </div>
          )}
          {!page && !error && <p role="status">Loading market…</p>}
          {page && !market && (
            <div className="empty">
              <h1>Market unavailable</h1>
              <Link href="/">Browse live markets</Link>
            </div>
          )}
          {market && (
            <>
              <p className="small muted">
                {market.competition || market.category || market.platform}
              </p>
              <h1>{market.eventTitle || market.question}</h1>
              {market.eventTitle && <h2>{conditionTitle(market)}</h2>}
              {market.scheduledAt && (
                <p>Scheduled {friendlyDate(market.scheduledAt)}</p>
              )}
              <section className="panel">
                <h2>Choose your view</h2>
                <div className="event-outcomes">
                  {market.outcomes.map((o, i) => (
                    <Button
                      key={i}
                      variant="outline"
                      onClick={() => {
                        setOutcome(o.name);
                        setSelection((n) => n + 1);
                        switchPane("Thesis");
                      }}
                    >
                      <span>{o.name}</span>
                      <strong>
                        {o.price === null
                          ? "Unavailable"
                          : outcomePrice(o.price)}
                      </strong>
                    </Button>
                  ))}
                </div>
                <p className="small muted">
                  {market.priceBasis === "last_trade"
                    ? "Last traded price"
                    : "Source outcome price"}{" "}
                  · Choosing opens a draft for review.
                </p>
              </section>
              <details className="panel">
                <summary>Rules & source</summary>
                <p style={{ whiteSpace: "pre-wrap" }}>
                  {market.rules || "Rules unavailable from this source."}
                </p>
                <p>Closes: {friendlyDate(market.closeTime)}</p>
                <p>Source updated: {friendlyDate(market.updatedAt)}</p>
                <p>Fetched: {friendlyDate(market.fetchedAt)}</p>
                <p>
                  {providerLabel(page!.provider)} · Native market: {market.id}
                </p>
                {market.eventId && <p>Event: {market.eventId}</p>}
                {market.marketScope && <p>Scope: {market.marketScope}</p>}
                {market.sourceUrl && (
                  <a
                    className="text-link"
                    href={market.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Original source ↗
                  </a>
                )}
              </details>
            </>
          )}
        </section>
        <div
          className={cn(
            "discovery-thesis",
            mobile !== "Thesis" && "mobile-hidden",
          )}
        >
          <ContextualThesis
            key={JSON.stringify([platform, id, source, selection])}
            market={market}
            provider={source}
            initialOutcome={outcome}
          />
        </div>
      </div>
    </main>
  );
}
