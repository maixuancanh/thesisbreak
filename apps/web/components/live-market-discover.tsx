"use client";
import { useEffect, useRef, useState } from "react";
import { CalendarDays, ImageIcon } from "lucide-react";
import { Button } from "./ui/button";
import { ContextualThesis } from "./contextual-thesis";
import { TatumEventSearch } from "./tatum-research";
import { cn } from "../lib/utils";
import { RollingPrice, QuoteBar } from "./rolling-price";
import {
  compactDate,
  participantConditions,
  conditionTitle,
  filterMarkets,
  groupEvents,
  marketIdentity,
} from "../lib/event-presentation";
import {
  fetchLivePage,
  providerLabel,
  type LiveMarket,
  type LivePage,
  type LivePlatform,
} from "../lib/live-market";
export function LiveMarketDiscover() {
  const [platform, setPlatform] = useState<LivePlatform>("kalshi");
  const [provider, setProvider] = useState("auto");
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState("");
  const [page, setPage] = useState<LivePage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [active, setActive] = useState<{
    market: LiveMarket;
    provider: "public" | "tatum";
    outcome: string;
    revision: number;
  } | null>(null);
  const [mobile, setMobile] = useState("Market");
  const positions = useRef<Record<string, number>>({ Market: 0, Thesis: 0 });
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
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
  async function load(cursor?: string) {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    const request = ++sequence.current;
    setLoading(true);
    setError("");
    if (!cursor) setPage(null);
    const query = new URLSearchParams({ platform, limit: "20" });
    if (provider !== "auto") query.set("provider", provider);
    if (cursor) query.set("cursor", cursor);
    try {
      const result = await fetchLivePage(query, c.signal);
      if (request !== sequence.current || c.signal.aborted) return;
      setPage((previous) =>
        cursor && previous
          ? {
              ...result,
              data: [
                ...previous.data,
                ...result.data.filter(
                  (m) =>
                    !previous.data.some(
                      (p) => p.platform === m.platform && p.id === m.id,
                    ),
                ),
              ],
            }
          : result,
      );
    } catch (cause) {
      if (!c.signal.aborted && request === sequence.current)
        setError(
          cause instanceof Error ? cause.message : "Markets unavailable.",
        );
    } finally {
      if (!c.signal.aborted && request === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    setFilter("");
    setCategory("");
    void load();
    return () => {
      controller.current?.abort();
      ++sequence.current;
    };
  }, [platform, provider, reload]);
  const source = page?.provider === "tatum" ? "tatum" : "public";
  const categories = [
    ...new Set(
      page?.data
        .map((m) => m.category)
        .filter((x): x is string => Boolean(x)) ?? [],
    ),
  ];
  const groups = groupEvents(
    filterMarkets(page?.data ?? [], filter, category),
    source,
  );
  function select(market: LiveMarket, outcome = "") {
    setActive((previous) => ({
      market,
      provider: source,
      outcome,
      revision: (previous?.revision ?? 0) + 1,
    }));
    switchPane("Thesis");
  }
  return (
    <main id="main" className="discover-v7">
      <div className="mobile-switch" aria-label="Discover view">
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
          <div className="discover-heading">
            <div>
              <h1>What happens next?</h1>
              <p className="muted">
                Explore the odds. Think it through with Thesis.
              </p>
            </div>
            <Button variant="outline" onClick={() => setReload((x) => x + 1)}>
              Refresh
            </Button>
          </div>
          <div className="catalog-toolbar">
            <label className="search">
              <span className="sr-only">Search loaded markets</span>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search loaded events"
              />
            </label>
            <label className="source-select">
              <span className="sr-only">Platform</span>
              <select
                value={platform}
                onChange={(e) => setPlatform(e.target.value as LivePlatform)}
              >
                <option value="kalshi">Kalshi</option>
                <option value="polymarket">Polymarket</option>
              </select>
            </label>
          </div>
          {provider === "tatum" && <TatumEventSearch platform={platform} />}
          <div
            className="filters category-tabs"
            aria-label="Categories in loaded markets"
          >
            <Button
              variant={!category ? "secondary" : "ghost"}
              aria-pressed={!category}
              onClick={() => setCategory("")}
            >
              All
            </Button>
            {categories.map((c) => (
              <Button
                key={c}
                variant={category === c ? "secondary" : "ghost"}
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
              >
                {c}
              </Button>
            ))}
          </div>
          <p className="small muted scope-note">
            Search and categories filter loaded markets only
            {page
              ? ` · ${page.data.length} conditions · ${providerLabel(page.provider)}`
              : ""}
            .
          </p>
          {page?.featuredSeries && (
            <p className="small muted scope-note">
              Featured: {page.featuredSeries}. More topics below.
            </p>
          )}
          {error && (
            <div className="connection" role="alert">
              {error}{" "}
              <Button variant="outline" onClick={() => setReload((x) => x + 1)}>
                Retry
              </Button>
            </div>
          )}
          {loading && (
            <div
              className="event-grid"
              role="status"
              aria-label="Loading markets"
            >
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="event-skeleton">
                  Loading event…
                </div>
              ))}
            </div>
          )}
          <div className="event-grid">
            {groups.map((group) => (
              <EventCard
                key={group.key}
                title={group.title}
                markets={group.markets}
                activeId={
                  active?.provider === source &&
                  active.market.platform === platform
                    ? active.market.id
                    : undefined
                }
                onSelect={select}
              />
            ))}
          </div>
          {!loading && page && !groups.length && (
            <div className="empty">
              <h2>No matching loaded events</h2>
              <Button
                variant="outline"
                onClick={() => {
                  setFilter("");
                  setCategory("");
                }}
              >
                Clear filters
              </Button>
            </div>
          )}
          {page?.nextCursor && (
            <Button
              disabled={loading}
              onClick={() => void load(page.nextCursor!)}
            >
              Load more events
            </Button>
          )}
          <details className="connection-settings">
            <summary>Data connection</summary>
            <label>
              Connection{" "}
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                <option value="auto">Automatic</option>
                <option value="public">Public API</option>
                <option value="tatum">Tatum</option>
              </select>
            </label>
          </details>
        </section>
        <div
          className={cn(
            "discovery-thesis",
            mobile !== "Thesis" && "mobile-hidden",
          )}
        >
          <ContextualThesis
            key={
              active
                ? marketIdentity(active.market, active.provider) +
                  active.revision
                : "empty"
            }
            market={active?.market}
            provider={active?.provider ?? source}
            initialOutcome={active?.outcome}
          />
        </div>
      </div>
    </main>
  );
}
function EventCard({
  title,
  markets,
  activeId,
  onSelect,
}: {
  title: string;
  markets: LiveMarket[];
  activeId?: string | undefined;
  onSelect: (market: LiveMarket, outcome?: string) => void;
}) {
  const [id, setId] = useState(markets[0]!.id);
  const m = markets.find((m) => m.id === id) ?? markets[0]!;
  const [failed, setFailed] = useState("");
  const date = compactDate(m.scheduledAt);
  const participants = participantConditions(markets);
  if (participants)
    return (
      <ParticipantEventCard
        title={title}
        participants={participants}
        activeId={activeId}
        onSelect={onSelect}
      />
    );
  return (
    <article
      className={cn("event-card", activeId === m.id && "event-selected")}
    >
      <div className="event-meta">
        <span>{m.competition || m.category || m.platform}</span>
        {date && (
          <span>
            <CalendarDays size={13} />
            {date}
          </span>
        )}
      </div>
      <div className="event-identity">
        {m.imageUrl && failed !== m.imageUrl ? (
          <img
            src={m.imageUrl}
            alt=""
            width={44}
            height={44}
            onError={() => setFailed(m.imageUrl!)}
          />
        ) : (
          <span className="event-image-fallback">
            <ImageIcon size={20} />
          </span>
        )}
        <h2>{title}</h2>
      </div>
      {markets.length > 1 ? (
        <label className="condition-selector">
          <span>{markets.length} market conditions</span>
          <select
            aria-label={`Market condition for ${title}`}
            value={m.id}
            onChange={(e) => setId(e.target.value)}
          >
            {markets.map((item) => (
              <option key={item.id} value={item.id}>
                {conditionTitle(item)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="event-condition">
          {m.eventTitle ? conditionTitle(m) : "Market condition"}
        </p>
      )}
      <div className="event-outcomes">
        {m.outcomes.map((o, i) => (
          <Button
            key={`${o.name}:${i}`}
            variant="outline"
            onClick={() => onSelect(m, o.name)}
          >
            <span className="quote-label">
              {o.name}
              <QuoteBar price={o.price} index={i} />
            </span>
            <strong>
              <RollingPrice price={o.price} />
            </strong>
          </Button>
        ))}
      </div>
      {!m.outcomes.length && (
        <p className="small muted">Outcomes unavailable</p>
      )}
      <div className="event-footer">
        <span className="small muted">
          {m.priceBasis === "last_trade" ? "Last trade" : "Source price"}
          {!date && m.closeTime
            ? ` · Closes ${compactDate(m.closeTime) ?? "unavailable"}`
            : ""}
        </span>
        <Button variant="ghost" onClick={() => onSelect(m)}>
          Discuss →
        </Button>
      </div>
    </article>
  );
}

function MarketImage({ market }: { market: LiveMarket }) {
  const [failed, setFailed] = useState(false);
  return market.imageUrl && !failed ? (
    <img
      src={market.imageUrl}
      alt=""
      width={44}
      height={44}
      onError={() => setFailed(true)}
    />
  ) : (
    <span className="event-image-fallback">
      <ImageIcon size={20} />
    </span>
  );
}
function ParticipantEventCard({
  title,
  participants,
  activeId,
  onSelect,
}: {
  title: string;
  participants: NonNullable<ReturnType<typeof participantConditions>>;
  activeId?: string | undefined;
  onSelect: (market: LiveMarket, outcome?: string) => void;
}) {
  const first = participants[0]!.market;
  const selected =
    participants.find((p) => p.market.id === activeId)?.market ?? first;
  return (
    <article
      className={cn(
        "event-card participant-card",
        participants.some((p) => p.market.id === activeId) && "event-selected",
      )}
    >
      <div className="event-meta">
        <span>{first.competition || first.category || first.platform}</span>
        <span>{first.marketScope}</span>
      </div>
      <h2 className="participant-event-title">{title}</h2>
      <div className="participant-identities">
        {participants.map((p) => (
          <div key={p.market.id}>
            <MarketImage market={p.market} />
            <strong>{p.label}</strong>
          </div>
        ))}
      </div>
      <p className="participant-schedule">
        {compactDate(first.scheduledAt) || "Schedule unavailable"}
      </p>
      <div className="event-outcomes">
        {participants.map((p, i) => (
          <Button
            key={p.market.id}
            variant="outline"
            onClick={() => onSelect(p.market, "Yes")}
          >
            <span className="quote-label">
              {p.label}
              <QuoteBar price={p.outcome.price} index={i} />
            </span>
            <strong>
              <RollingPrice price={p.outcome.price} />
            </strong>
          </Button>
        ))}
      </div>
      <div className="event-footer">
        <span className="small muted">
          {first.priceBasis === "last_trade" ? "Last trade" : "Source price"} ·
          Yes contracts
        </span>
        <Button variant="ghost" onClick={() => onSelect(selected)}>
          Discuss →
        </Button>
      </div>
    </article>
  );
}
