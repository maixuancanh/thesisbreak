"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  livePageSchema,
  liveMarketPath,
  type LiveMarket,
} from "../lib/live-market";
import { RollingPrice } from "./rolling-price";
export function EventConditions({ market }: { market: LiveMarket }) {
  const [rows, setRows] = useState<LiveMarket[]>([]),
    [state, setState] = useState("loading");
  useEffect(() => {
    if (!market.eventId) {
      setState("unsupported");
      return;
    }
    const c = new AbortController();
    setState("loading");
    setRows([]);
    fetch(
      `/api/event-markets?${new URLSearchParams({ id: market.eventId, platform: market.platform })}`,
      {
        signal: c.signal,
      },
    )
      .then(async (r) => {
        if (!r.ok) throw Error();
        return livePageSchema.parse(await r.json());
      })
      .then((d) => {
        if (!c.signal.aborted) {
          setRows(d.data);
          setState("done");
        }
      })
      .catch(() => {
        if (!c.signal.aborted) setState("error");
      });
    return () => c.abort();
  }, [market.platform, market.eventId]);
  if (state === "unsupported") return null;
  return (
    <section className="event-conditions">
      <div className="row">
        <h2>Markets in this event</h2>
        <span>{rows.length ? `${rows.length} conditions` : ""}</span>
      </div>
      {state === "loading" ? (
        <p role="status">Loading event markets…</p>
      ) : state === "error" ? (
        <p>Other markets could not be loaded.</p>
      ) : (
        rows.map((m) => (
          <Link
            key={m.id}
            href={liveMarketPath(
              m,
              m.platform === "kalshi" ? "kalshi-public" : "polymarket-public",
            )}
            className="event-condition-row"
            aria-current={market.id === m.id ? "page" : undefined}
          >
            <span>
              {m.imageUrl && (
                <img src={m.imageUrl} alt="" width={36} height={36} />
              )}
              <span>
                <strong>{m.conditionLabel || m.question}</strong>
                <small>
                  {m.resolution
                    ? "Resolved"
                    : ((
                        {
                          active: "Open",
                          initialized: "Upcoming",
                          closed: "Closed",
                          settled: "Resolved",
                          finalized: "Resolved",
                        } as Record<string, string>
                      )[m.status ?? ""] ?? "Status unavailable")}
                </small>
              </span>
            </span>
            <RollingPrice
              price={m.outcomes.find((o) => o.name === "Yes")?.price ?? null}
            />
            <span className="condition-view">View →</span>
          </Link>
        ))
      )}
    </section>
  );
}
