"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  ArrowUp,
  Search,
  X,
  BookOpen,
  SlidersHorizontal,
  MessageCircle,
} from "lucide-react";
import {
  fetchLivePage,
  liveMarketPath,
  type LiveMarket,
  type LivePage,
  type LivePlatform,
} from "../lib/live-market";
import {
  groupEvents,
  participantConditions,
  filterMarkets,
  marketIdentity,
} from "../lib/event-presentation";
import { RollingPrice, QuoteBar } from "./rolling-price";
import { ContextualThesis } from "./contextual-thesis";
import { useAccountSession } from "./account-session";
import { SignInLink } from "./sign-in-link";

const topics = [
  ["Trending", ""],
  ["Sports", "Sports"],
  ["Politics", "Politics"],
  ["Elections", "Elections"],
  ["Crypto", "Crypto"],
  ["Tech", "Science and Technology"],
  ["Finance", "Economics"],
  ["Weather", "Climate and Weather"],
] as const;
export function Discover() {
  const drawer = useRef<HTMLElement | null>(null);
  const requestedAgent = useRef(false);
  const pagination = useRef<AbortController | null>(null);
  const [page, setPage] = useState<LivePage | null>(null),
    [platform, setPlatform] = useState<LivePlatform>("kalshi"),
    [topic, setTopic] = useState(""),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0);
  const [active, setActive] = useState<{
    market: LiveMarket;
    outcome: string;
  } | null>(null);
  useEffect(() => {
    setQuery(new URLSearchParams(location.search).get("q") ?? "");
  }, []);
  useEffect(() => {
    const c = new AbortController();
    setPage(null);
    setBusy(true);
    setError("");
    fetchLivePage(
      new URLSearchParams({ platform, provider: "public", limit: "40" }),
      c.signal,
    )
      .then((p) => {
        if (!c.signal.aborted) setPage(p);
      })
      .catch(() => {
        if (!c.signal.aborted) setError("Markets are taking longer to load.");
      })
      .finally(() => {
        if (!c.signal.aborted) setBusy(false);
      });
    return () => {
      c.abort();
      pagination.current?.abort();
    };
  }, [platform, reload]);
  useEffect(() => {
    const c = new AbortController();
    let pending = false;
    const timer = setInterval(async () => {
      if (document.hidden || pending) return;
      pending = true;
      try {
        const fresh = await fetchLivePage(
          new URLSearchParams({ platform, provider: "public", limit: "40" }),
          c.signal,
        );
        if (!c.signal.aborted)
          setPage((old) =>
            old
              ? {
                  ...old,
                  fetchedAt: fresh.fetchedAt,
                  data: old.data.map(
                    (m) => fresh.data.find((n) => n.id === m.id) ?? m,
                  ),
                }
              : old,
          );
      } catch {
        /* Keep the last source quote when refresh fails. */
      } finally {
        pending = false;
      }
    }, 60000);
    return () => {
      clearInterval(timer);
      c.abort();
    };
  }, [platform]);
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    drawer.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(null);
      if (e.key === "Tab") {
        const controls = Array.from(
          drawer.current?.querySelectorAll<HTMLElement>(
            'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]',
          ) ?? [],
        ).filter((el) => el.getClientRects().length);
        const first = controls[0],
          last = controls.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [active]);
  useEffect(() => {
    if (
      !page ||
      requestedAgent.current ||
      new URLSearchParams(location.search).get("agent") !== "1"
    )
      return;
    requestedAgent.current = true;
    const market = page.data[0];
    if (market) setActive({ market, outcome: "" });
  }, [page]);
  const groups = groupEvents(
    filterMarkets(page?.data ?? [], query, topic),
    "public",
  );
  async function more() {
    if (!page?.nextCursor || busy) return;
    const c = new AbortController();
    pagination.current = c;
    setBusy(true);
    try {
      const p = await fetchLivePage(
        new URLSearchParams({
          platform,
          provider: "public",
          limit: "40",
          cursor: page.nextCursor,
        }),
        c.signal,
      );
      if (c.signal.aborted) return;
      setPage((old) => ({
        ...p,
        data: [
          ...(old?.data ?? []),
          ...p.data.filter((m) => !old?.data.some((o) => o.id === m.id)),
        ],
      }));
    } catch {
      if (!c.signal.aborted) setError("Couldn't load more events. Try again.");
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  return (
    <main id="main" className="worm-terminal">
      <div
        className="terminal-topics"
        role="group"
        aria-label="Market categories"
      >
        {topics.map(([label, value]) => (
          <button
            key={label}
            aria-pressed={topic === value}
            onClick={() => setTopic(value)}
          >
            {label}
          </button>
        ))}
        <button
          className="terminal-platform"
          onClick={() => {
            setPlatform((p) => (p === "kalshi" ? "polymarket" : "kalshi"));
            setTopic("");
          }}
        >
          <SlidersHorizontal size={13} />
          {platform === "kalshi" ? "Kalshi" : "Polymarket"}
        </button>
      </div>
      {query && (
        <div className="terminal-search-result">
          <Search size={14} /> Results for “{query}”{" "}
          <button onClick={() => setQuery("")} aria-label="Clear search">
            <X size={14} />
          </button>
        </div>
      )}
      {error && (
        <div className="terminal-error" role="alert">
          {error}
          <button onClick={() => setReload((n) => n + 1)}>Retry</button>
        </div>
      )}
      <div className="terminal-grid">
        <SourceWatch />
        <AgentEntry
          onOpen={() => {
            if (groups[0])
              setActive({ market: groups[0].markets[0]!, outcome: "" });
          }}
          hasMarkets={groups.length > 0}
        />
        {groups.map((group) => (
          <TerminalCard
            key={group.key}
            group={group}
            onSelect={(market, outcome) => setActive({ market, outcome })}
          />
        ))}
        {busy &&
          !page &&
          Array.from({ length: 8 }, (_, i) => (
            <div
              className="terminal-skeleton"
              aria-label="Loading event"
              key={i}
            />
          ))}
      </div>
      {!busy && !groups.length && !error && (
        <div className="terminal-empty">
          No events in this view.
          <button
            onClick={() => {
              setTopic("");
              setQuery("");
            }}
          >
            Show all events
          </button>
        </div>
      )}
      <footer className="terminal-footer">
        <span>
          {page
            ? `${page.data.length} live conditions · ${platform === "kalshi" ? "Kalshi" : "Polymarket"}`
            : "Loading live markets"}{" "}
          · Research only
        </span>
        {page?.nextCursor && (
          <button disabled={busy} onClick={() => void more()}>
            {busy ? "Loading…" : "More events"}
          </button>
        )}
        <Link href="/picks">
          My picks <ArrowUpRight size={12} />
        </Link>
      </footer>
      {active && (
        <div className="terminal-agent-layer">
          <button
            className="terminal-scrim"
            onClick={() => setActive(null)}
            aria-label="Close agent"
          />
          <aside
            ref={drawer}
            role="dialog"
            aria-modal="true"
            className="terminal-agent-drawer"
            aria-label="Event discussion"
          >
            <button
              className="drawer-close"
              onClick={() => setActive(null)}
              aria-label="Close discussion"
            >
              <X size={18} />
            </button>
            <ContextualThesis
              key={marketIdentity(active.market, "public") + active.outcome}
              market={active.market}
              provider="public"
              initialOutcome={active.outcome}
            />
          </aside>
        </div>
      )}
    </main>
  );
}
type Group = ReturnType<typeof groupEvents>[number];
function Artwork({ market, size = 56 }: { market: LiveMarket; size?: number }) {
  const [failed, setFailed] = useState(false);
  return market.imageUrl && !failed ? (
    <img
      src={market.imageUrl}
      alt=""
      width={size}
      height={size}
      onError={() => setFailed(true)}
    />
  ) : (
    <span
      className="terminal-art-fallback"
      style={{ width: size, height: size }}
    >
      {(market.conditionLabel || market.eventTitle || market.question)
        .slice(0, 2)
        .toUpperCase()}
    </span>
  );
}
function TerminalCard({
  group,
  onSelect,
}: {
  group: Group;
  onSelect: (m: LiveMarket, o: string) => void;
}) {
  const m = group.markets[0]!,
    participants = participantConditions(group.markets);
  const rows = participants
    ? participants.map((p) => ({
        label: p.label,
        price: p.outcome.price,
        market: p.market,
        outcome: "Yes",
      }))
    : group.markets.length > 1
      ? group.markets.map((m) => ({
          label: m.conditionLabel || m.question,
          price: m.outcomes.find((o) => o.name === "Yes")?.price ?? null,
          market: m,
          outcome: "Yes",
        }))
      : m.outcomes.map((o) => ({
          label: o.name,
          price: o.price,
          market: m,
          outcome: o.name,
        }));
  const visible = rows.slice(0, 2),
    volume = m.volume;
  return (
    <article
      className={`terminal-card ${participants ? "terminal-sport" : ""}`}
    >
      <Link
        className="terminal-card-heading"
        href={liveMarketPath(m, "kalshi-public")}
      >
        <Artwork market={m} />
        <div>
          <h2 title={group.title}>{group.title}</h2>
          <p>
            {volume !== undefined
              ? `${new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(volume)} ${m.volumeUnit === "usd" ? "USD" : "contracts"} Vol.`
              : m.competition || m.category || m.platform}
          </p>
        </div>
      </Link>
      <div className="terminal-quotes">
        {visible.map((r, i) => (
          <button
            className="terminal-quote"
            key={r.market.id + r.outcome}
            onClick={() => onSelect(r.market, r.outcome)}
          >
            <span className="terminal-quote-name">
              {participants && <Artwork market={r.market} size={28} />}
              <span>
                {r.label}
                <QuoteBar price={r.price} index={i} />
              </span>
            </span>
            <RollingPrice price={r.price} />
          </button>
        ))}
      </div>
      <div className="terminal-card-actions">
        {rows.length > 2 ? (
          <Link href={liveMarketPath(m, "kalshi-public")}>
            {rows.length - 2} more markets
          </Link>
        ) : (
          visible.map((r) => (
            <button
              key={r.market.id + r.outcome}
              onClick={() => onSelect(r.market, r.outcome)}
            >
              {r.label}
            </button>
          ))
        )}
      </div>
    </article>
  );
}
function SourceWatch() {
  const { status } = useAccountSession();
  const [rows, setRows] = useState<
      {
        id: string;
        payload: {
          sourceName: string;
          kind: string;
          performance: { scored: number; matched: number };
        };
      }[]
    >([]),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!status?.authenticated) return;
    const c = new AbortController();
    fetch("/api/sources", { signal: c.signal })
      .then(async (r) => {
        if (!r.ok) throw Error();
        const d = await r.json();
        if (!c.signal.aborted && Array.isArray(d.data)) setRows(d.data);
      })
      .catch(() => {
        if (!c.signal.aborted) setFailed(true);
      });
    return () => c.abort();
  }, [status?.authenticated]);
  return (
    <section className="terminal-source-watch">
      <h2>Sources you follow</h2>
      <div className="source-watch-tabs">
        <span>All</span>
        <Link href="/memory">
          Your history <ArrowUpRight size={12} />
        </Link>
      </div>
      {status?.authenticated && rows.length ? (
        <ol>
          {rows.slice(0, 8).map((r, i) => (
            <li key={r.id}>
              <span className="source-rank">{i + 1}</span>
              <span className="source-avatar">
                {r.payload.sourceName.slice(0, 1)}
              </span>
              <div>
                <strong>{r.payload.sourceName}</strong>
                <small>
                  {r.payload.performance.scored
                    ? `${r.payload.performance.matched}/${r.payload.performance.scored} matched`
                    : "Not scored yet"}{" "}
                  ·{" "}
                  {r.payload.kind === "market_baseline"
                    ? "Market baseline"
                    : "Reported source"}
                </small>
              </div>
              <Link href="/memory">View</Link>
            </li>
          ))}
        </ol>
      ) : (
        <div className="source-watch-empty">
          <BookOpen size={28} strokeWidth={1.3} />
          <h3>A track record starts here.</h3>
          <p>
            Follow a source. Remember its calls.
            <br />
            See what holds up over time.
          </p>
          {status?.authenticated ? (
            <Link className="terminal-pill" href="/memory">
              {failed ? "Open source history" : "Explore your memory"}
            </Link>
          ) : (
            <SignInLink className="terminal-pill">
              Sign in to follow sources
            </SignInLink>
          )}
        </div>
      )}
      <p className="source-watch-foot">Your history, remembered with Walrus.</p>
    </section>
  );
}
function AgentEntry({
  onOpen,
  hasMarkets,
}: {
  onOpen: () => void;
  hasMarkets: boolean;
}) {
  return (
    <section className="terminal-agent-entry">
      <div className="entry-top">
        <div>
          <span>Research agent</span>
          <h2>
            Thesis
            <span className="agent-ready-dot" />
          </h2>
        </div>
        <Link href="/memory" aria-label="Agent memory">
          <BookOpen size={17} />
        </Link>
      </div>
      <div className="entry-summary">
        <span>Your view</span>
        <strong>Make it count.</strong>
        <p>
          A second opinion that remembers
          <br />
          how you got here.
        </p>
      </div>
      <div className="entry-invitation">
        <MessageCircle size={28} strokeWidth={1.2} />
        <h3>Let's think it through</h3>
        <p>Choose a market to explore the evidence with Thesis.</p>
        <button
          className="terminal-pill"
          disabled={!hasMarkets}
          onClick={onOpen}
        >
          Start a conversation <ArrowUp size={14} />
        </button>
      </div>
      <div className="entry-bottom">
        <Link href="/picks">My picks</Link>
        <Link href="/week">
          This week <ArrowUpRight size={12} />
        </Link>
      </div>
    </section>
  );
}
