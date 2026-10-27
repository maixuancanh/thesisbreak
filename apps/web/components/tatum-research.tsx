"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { z } from "zod";
import { Button } from "./ui/button";
import {
  friendlyDate,
  liveMarketPath,
  type LiveMarket,
  type LivePlatform,
} from "../lib/live-market";
const reference = z.object({
  platform: z.enum(["kalshi", "polymarket"]),
  id: z.string().min(1).max(128),
});
const event = z.object({
  id: z.string(),
  platform: z.enum(["kalshi", "polymarket"]),
  title: z.string().nullable(),
  closeTime: z.string().nullable(),
  marketCount: z.number(),
  markets: z.array(z.union([z.string(), reference])).nullable(),
  source: z.object({ url: z.string() }),
});
const eventResponse = z.object({
  data: z.union([
    z.array(event),
    z.object({
      events: z.array(event),
      pagination: z.object({ hasMore: z.boolean() }),
    }),
  ]),
  fetchedAt: z.string(),
});
function native(platform: LivePlatform, id: string) {
  return platform === "kalshi"
    ? /^[A-Z][A-Z0-9_.-]{0,127}$/.test(id)
    : /^0x[a-fA-F0-9]{64}$/.test(id);
}
async function get(query: URLSearchParams, signal: AbortSignal) {
  const response = await fetch("/api/markets/tatum-research?" + query, {
    cache: "no-store",
    signal,
  });
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "Sign in to use this research source."
        : response.status === 429
          ? "This source has reached its request allowance. Try again later."
          : "This research source is not available right now.",
    );
  return response.json() as Promise<unknown>;
}
export function TatumEventSearch({ platform }: { platform: LivePlatform }) {
  const [term, setTerm] = useState(""),
    [rows, setRows] = useState<z.infer<typeof event>[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [at, setAt] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    setBusy(false);
    setRows([]);
    setAt("");
    setError("");
    return () => active.current?.abort();
  }, [platform]);
  async function load() {
    active.current?.abort();
    const c = new AbortController();
    active.current = c;
    setBusy(true);
    setError("");
    setRows([]);
    setAt("");
    try {
      const query = new URLSearchParams({
        operation:
          platform === "polymarket" && term.trim() ? "search" : "events",
        platform,
      });
      if (query.get("operation") === "search") {
        query.set("q", term.trim());
        query.set("limitPerType", "10");
      } else {
        query.set("limit", "10");
        query.set("includeMarkets", "true");
        query.set("sort", "endingSoon");
      }
      const result = eventResponse.parse(await get(query, c.signal));
      if (!c.signal.aborted) {
        setRows(Array.isArray(result.data) ? result.data : result.data.events);
        setAt(result.fetchedAt);
      }
    } catch (e) {
      if (!c.signal.aborted)
        setError(e instanceof Error ? e.message : "Source unavailable.");
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  return (
    <details className="panel">
      <summary>Find more events</summary>
      <p className="small muted">
        Search the source directly. Results are separate from the loaded-market
        filter.
      </p>
      {platform === "polymarket" && (
        <label>
          Search events
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Team, topic or event"
            maxLength={128}
          />
        </label>
      )}
      <Button
        variant="outline"
        disabled={
          busy ||
          (!!term.trim() && platform === "polymarket" && term.trim().length < 2)
        }
        onClick={() => void load()}
      >
        {busy
          ? "Searching…"
          : platform === "polymarket" && term.trim()
            ? "Search events"
            : "Browse upcoming events"}
      </Button>
      {error && <p role="status">{error}</p>}
      {at && (
        <p className="small muted">
          Source checked {friendlyDate(at)}
          {!rows.length ? " · No matching events returned." : ""}
        </p>
      )}
      {rows.map((row) => (
        <article key={row.platform + row.id}>
          <h3>{row.title || row.id}</h3>
          <p className="small muted">
            {row.marketCount} conditions · Closes {friendlyDate(row.closeTime)}
          </p>
          {(row.markets ?? []).slice(0, 10).map((m) => {
            const id = typeof m === "string" ? m : m.id;
            return native(row.platform, id) ? (
              <p key={id}>
                <Link
                  href={liveMarketPath({ platform: row.platform, id }, "tatum")}
                >
                  Review condition {id}
                </Link>
              </p>
            ) : null;
          })}
          {!row.markets?.length && (
            <p className="small muted">
              Condition details were not included in this result.
            </p>
          )}
        </article>
      ))}
    </details>
  );
}
const price = z.number().finite().min(0).max(1).nullable();
const quoteResponse = z.object({
  fetchedAt: z.string(),
  data: z.object({
    marketId: z.string(),
    platform: z.enum(["kalshi", "polymarket"]),
    timestamp: z.string(),
    yes: z.object({ bid: price, ask: price }),
    no: z.object({ bid: price, ask: price }),
    spread: price,
    volume24h: z.number().nullable(),
    volumeUnit: z.enum(["usd", "contracts"]).nullable(),
  }),
});
const historyResponse = z.object({
  fetchedAt: z.string(),
  data: z.object({
    marketId: z.string(),
    platform: z.enum(["kalshi", "polymarket"]),
    partial: z.boolean(),
    availableFrom: z.string().nullable(),
    candles: z
      .array(
        z.object({ timestamp: z.string(), close: z.number().min(0).max(1) }),
      )
      .max(2000),
  }),
});
const pct = (value: number | null) =>
  value === null ? "Unavailable" : `${(value * 100).toFixed(1)}¢`;
export function TatumMarketPulse({ market }: { market: LiveMarket }) {
  const [quote, setQuote] = useState<z.infer<typeof quoteResponse> | null>(
      null,
    ),
    [history, setHistory] = useState<z.infer<typeof historyResponse> | null>(
      null,
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const c = useRef<AbortController | null>(null);
  useEffect(() => {
    setBusy(false);
    setQuote(null);
    setHistory(null);
    setError("");
    return () => c.current?.abort();
  }, [market.platform, market.id]);
  async function load() {
    c.current?.abort();
    const abort = new AbortController();
    c.current = abort;
    setBusy(true);
    setError("");
    setQuote(null);
    setHistory(null);
    const now = new Date();
    now.setUTCMinutes(0, 0, 0);
    const base = { platform: market.platform, id: market.id };
    const results = await Promise.allSettled([
      get(new URLSearchParams({ ...base, operation: "quote" }), abort.signal),
      get(
        new URLSearchParams({
          ...base,
          operation: "history",
          interval: "1h",
          source: "candlesticks",
          start: new Date(now.getTime() - 7 * 86400000).toISOString(),
          end: now.toISOString(),
        }),
        abort.signal,
      ),
    ]);
    if (abort.signal.aborted) return;
    const q = results[0],
      h = results[1];
    const parsed =
      q.status === "fulfilled" ? quoteResponse.safeParse(q.value) : null;
    const past =
      h.status === "fulfilled" ? historyResponse.safeParse(h.value) : null;
    if (
      parsed?.success &&
      parsed.data.data.marketId === market.id &&
      parsed.data.data.platform === market.platform
    )
      setQuote(parsed.data);
    if (
      past?.success &&
      past.data.data.marketId === market.id &&
      past.data.data.platform === market.platform
    )
      setHistory(past.data);
    if (
      !parsed?.success ||
      !past?.success ||
      (parsed.success &&
        (parsed.data.data.marketId !== market.id ||
          parsed.data.data.platform !== market.platform)) ||
      (past.success &&
        (past.data.data.marketId !== market.id ||
          past.data.data.platform !== market.platform))
    )
      setError(
        "Some price information is unavailable. Missing data is not a zero price or a settled result.",
      );
    setBusy(false);
  }
  return (
    <details className="panel">
      <summary>Price & recent movement</summary>
      <p className="small muted">
        Current bid/ask and seven days of hourly history from Tatum. This
        describes the market, not the final result.
      </p>
      <Button variant="outline" disabled={busy} onClick={() => void load()}>
        {busy ? "Checking prices…" : "Check prices"}
      </Button>
      {error && <p role="status">{error}</p>}
      {quote && (
        <>
          <p>
            Yes: bid {pct(quote.data.yes.bid)} · ask {pct(quote.data.yes.ask)}
          </p>
          <p>
            No: bid {pct(quote.data.no.bid)} · ask {pct(quote.data.no.ask)}
          </p>
          <p className="small muted">
            Spread {pct(quote.data.spread)} · 24h volume{" "}
            {quote.data.volume24h ?? "Unavailable"}{" "}
            {quote.data.volumeUnit ?? ""} · Quote time{" "}
            {friendlyDate(quote.data.timestamp)} · Retrieved{" "}
            {friendlyDate(quote.fetchedAt)}
          </p>
        </>
      )}
      {history && (
        <>
          <p className="small muted">
            {history.data.partial ? "Partial history. " : ""}Available from{" "}
            {friendlyDate(history.data.availableFrom)} · Retrieved{" "}
            {friendlyDate(history.fetchedAt)}
          </p>
          {history.data.candles.length ? (
            <>
              <p>
                First recorded close {pct(history.data.candles[0]!.close)} →
                latest {pct(history.data.candles.at(-1)!.close)}
              </p>
              <details>
                <summary>Hourly prices</summary>
                <table>
                  <thead>
                    <tr>
                      <th>Hour</th>
                      <th>Close</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.data.candles.slice(-48).map((row) => (
                      <tr key={row.timestamp}>
                        <td>{friendlyDate(row.timestamp)}</td>
                        <td>{pct(row.close)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="small muted">
                  Latest 48 rows shown; missing hours are not filled in.
                </p>
              </details>
            </>
          ) : (
            <p>No candles returned for this range.</p>
          )}
        </>
      )}
    </details>
  );
}
const savedRows = z.object({
  data: z
    .array(
      z.object({
        platform: z.enum(["kalshi", "polymarket"]),
        native_id: z.string(),
        current_version: z.number(),
        fetched_at: z.string().nullable(),
        outcomes: z
          .array(z.object({ name: z.string(), price: z.number().nullable() }))
          .nullable(),
      }),
    )
    .max(100),
});
export function SavedMarketChange({ market }: { market: LiveMarket }) {
  const [saved, setSaved] = useState<
    z.infer<typeof savedRows>["data"][number] | null
  >(null);
  useEffect(() => {
    const abort = new AbortController();
    setSaved(null);
    void fetch("/api/picks", { cache: "no-store", signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const result = savedRows.safeParse(await response.json());
        if (result.success && !abort.signal.aborted)
          setSaved(
            result.data.data.find(
              (row) =>
                row.platform === market.platform && row.native_id === market.id,
            ) ?? null,
          );
      })
      .catch(() => {});
    return () => abort.abort();
  }, [market.platform, market.id]);
  if (!saved) return null;
  return (
    <details className="panel">
      <summary>Since you saved your pick</summary>
      <p className="small muted">
        Saved snapshot {friendlyDate(saved.fetched_at)} · Current record{" "}
        {friendlyDate(market.fetchedAt)}. Prices may use different observation
        times; they do not establish the final result.
      </p>
      <table>
        <thead>
          <tr>
            <th>Outcome</th>
            <th>When saved</th>
            <th>Current record</th>
          </tr>
        </thead>
        <tbody>
          {market.outcomes.map((outcome) => (
            <tr key={outcome.name}>
              <td>{outcome.name}</td>
              <td>
                {pct(
                  saved.outcomes?.find((old) => old.name === outcome.name)
                    ?.price ?? null,
                )}
              </td>
              <td>{pct(outcome.price)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
