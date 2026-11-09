"use client";
import { usePickReviewEnabled } from "./pick-review-feature";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Search, ArrowUpRight, ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "./ui/dialog";
import { pickListPage, type PickListFilter } from "../lib/pick-list";
import { z } from "zod";
import { ActionHistory } from "./action-history";
import { SignInLink } from "./sign-in-link";
import { Button } from "./ui/button";
import { WatchPick } from "./watch-pick";
import { WorkspaceLoading } from "./workspace-loading";
import { PickReasonForm } from "./pick-reason-form";
import { PortfolioConnections } from "./portfolio-connections";
import { DecisionRecap } from "./decision-recap";
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
      advice_reviews: z
        .array(
          z.object({ dependency_status: z.string(), explanation: z.string() }),
        )
        .optional(),
    }),
  ),
});
export function AccountPicks() {
  const reviewEnabled = usePickReviewEnabled();
  const [rows, setRows] = useState<z.infer<typeof records>["data"] | null>(
      null,
    ),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0);
  const [filter, setFilter] = useState<PickListFilter>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState("Overview");
  const listing = pickListPage(rows ?? [], filter, query, page);
  const selected = rows?.find((p) => p.id === selectedId);
  const opener = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    function openLinkedPick() {
      const target = window.location.hash.slice(1);
      const id = target.startsWith("pick-") ? target.slice(5) : "";
      if (rows?.some((pick) => pick.id === id)) {
        setDetailTab("Overview");
        setSelectedId(id);
      }
    }
    window.addEventListener("hashchange", openLinkedPick);
    return () => window.removeEventListener("hashchange", openLinkedPick);
  }, [rows]);
  function openPick(id: string, trigger: HTMLButtonElement) {
    opener.current = trigger;
    setDetailTab("Overview");
    setSelectedId(id);
  }
  useEffect(() => {
    const c = new AbortController();
    setRows(null);
    setError("");
    void fetch("/api/picks", { signal: c.signal, cache: "no-store" })
      .then(async (r) => {
        if (!r.ok)
          throw Error(
            r.status === 401
              ? "Sign in to see your account picks."
              : "Account picks are unavailable. Try again later.",
          );
        const result = records.parse(await r.json());
        if (!c.signal.aborted) {
          setRows(result.data);
          const target = window.location.hash.slice(1);
          if (target.startsWith("pick-")) {
            const id = target.slice(5);
            if (result.data.some((p) => p.id === id)) setSelectedId(id);
          }
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError((e as Error).message);
      });
    return () => c.abort();
  }, [reload]);
  return (
    <main id="main" className="page picks-page picks-library">
      <div className="row">
        <div>
          <h1>My picks</h1>
          <p className="lead">Your picks, with the reasons behind them.</p>
        </div>
        <div className="picks-header-actions">
          {reviewEnabled && (
            <Button variant="outline" asChild>
              <Link href="/today">Review changes</Link>
            </Button>
          )}
          <Button asChild>
            <Link href="/">Add a pick</Link>
          </Button>
        </div>
      </div>
      {error ? (
        <div className="connection" role="alert">
          <p>{error}</p>
          {error.startsWith("Sign in") && <SignInLink>Sign in</SignInLink>}
          <Button variant="outline" onClick={() => setReload((x) => x + 1)}>
            Retry
          </Button>
        </div>
      ) : !rows ? (
        <WorkspaceLoading label="Loading your picks" />
      ) : (
        <>
          {rows.length > 0 && <PortfolioConnections key={reload} />}
          {rows.length > 0 && (
            <div className="picks-toolbar">
              <nav className="memory-filters" aria-label="Pick status">
                {(
                  [
                    ["all", "All picks"],
                    ["review", "Needs review"],
                    ["active", "Following"],
                    ["paused", "Paused"],
                    ["archived", "Archived"],
                  ] as const
                )
                  .filter(
                    ([value]) =>
                      value === "all" ||
                      value === filter ||
                      pickListPage(rows, value, "", 1).total > 0,
                  )
                  .map(([value, label]) => (
                    <Button
                      key={value}
                      variant={filter === value ? "default" : "ghost"}
                      aria-pressed={filter === value}
                      onClick={() => {
                        setFilter(value);
                        setPage(1);
                      }}
                    >
                      {label}{" "}
                      <span className="memory-count">
                        {pickListPage(rows, value, "", 1).total}
                      </span>
                    </Button>
                  ))}
              </nav>
              <label className="memory-search">
                <Search size={16} aria-hidden="true" />
                <input
                  type="search"
                  aria-label="Search picks"
                  placeholder="Search picks, teams or reasons..."
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(1);
                  }}
                />
              </label>
            </div>
          )}
          {!rows.length ? (
            <div className="empty">
              <h2>Your first pick starts with a market</h2>
              <p>Choose an outcome and record why you believe in it.</p>
              <Button asChild>
                <Link href="/">Explore markets</Link>
              </Button>
            </div>
          ) : !listing.total ? (
            <div className="memory-empty">
              <h2>No matching picks</h2>
              <p>Try another search or status.</p>
              <Button
                variant="outline"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                  setPage(1);
                }}
              >
                Show all picks
              </Button>
            </div>
          ) : (
            <>
              <div className="picks-list" aria-label="Your saved picks">
                {listing.items.map((p) => (
                  <article
                    className="pick-list-row"
                    id={`pick-${p.id}`}
                    key={p.id}
                  >
                    <div className="pick-list-main">
                      <p className="pick-list-meta">
                        {p.platform}
                        {p.event_title ? ` / ${p.event_title}` : ""}
                      </p>
                      <button
                        className="pick-list-question"
                        aria-haspopup="dialog"
                        onClick={(event) => openPick(p.id, event.currentTarget)}
                      >
                        {p.question ?? p.native_id}
                      </button>
                      <p className="pick-list-reason">
                        {p.reason || "No reason recorded"}
                      </p>
                    </div>
                    <div className="pick-list-summary">
                      <span className="pick-outcome">{p.outcome}</span>
                      <span
                        className={
                          p.advice_reviews?.length
                            ? "pick-state needs-review"
                            : "pick-state"
                        }
                      >
                        {p.advice_reviews?.length
                          ? "Needs review"
                          : p.state.replaceAll("_", " ")}
                      </span>
                    </div>
                    <time className="pick-list-date" dateTime={p.created_at}>
                      {Number.isFinite(Date.parse(p.created_at))
                        ? new Intl.DateTimeFormat("en", {
                            month: "short",
                            day: "numeric",
                          }).format(new Date(p.created_at))
                        : "Saved"}
                    </time>
                    <ChevronRight
                      className="pick-list-arrow"
                      size={16}
                      aria-hidden="true"
                    />
                  </article>
                ))}
              </div>
              {listing.pages > 1 && (
                <nav className="memory-pagination" aria-label="Pick pages">
                  <span aria-live="polite">
                    {listing.start}-{listing.end} of {listing.total} picks
                  </span>
                  <div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={listing.page === 1}
                      onClick={() => setPage(listing.page - 1)}
                    >
                      Previous
                    </Button>
                    <span>
                      Page {listing.page} of {listing.pages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={listing.page === listing.pages}
                      onClick={() => setPage(listing.page + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </nav>
              )}
            </>
          )}
          <div className="picks-history-link">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="ghost">Decision history</Button>
              </DialogTrigger>
              <DialogContent className="memory-dialog pick-details-dialog">
                <DialogTitle>Decision history</DialogTitle>
                <DialogDescription>
                  Your confirmed changes and recorded results.
                </DialogDescription>
                <ActionHistory />
              </DialogContent>
            </Dialog>
          </div>
        </>
      )}
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        {selected && (
          <DialogContent
            className="memory-dialog pick-details-dialog"
            onCloseAutoFocus={(event) => {
              if (opener.current?.isConnected) {
                event.preventDefault();
                opener.current.focus();
              }
            }}
          >
            <DialogTitle>{selected.question ?? selected.native_id}</DialogTitle>
            <DialogDescription>
              {selected.platform} / Your pick: {selected.outcome}
            </DialogDescription>
            <nav className="pick-detail-tabs" aria-label="Pick details">
              {[
                "Overview",
                ...(reviewEnabled ? ["Reason & checks"] : []),
                "Watch",
                ...(reviewEnabled ? ["Recap"] : []),
              ].map((tab) => (
                <Button
                  key={tab}
                  size="sm"
                  variant={detailTab === tab ? "default" : "ghost"}
                  aria-pressed={detailTab === tab}
                  onClick={() => setDetailTab(tab)}
                >
                  {tab}
                </Button>
              ))}
            </nav>
            <section
              hidden={detailTab !== "Overview"}
              className="pick-detail-section"
            >
              <h3>Your reason</h3>
              <p className="pick-full-reason">
                {selected.reason || "No reason recorded."}
              </p>
              <p className="small muted">
                Saved {friendlyDate(selected.created_at)}
              </p>
              {selected.advice_reviews?.map((review, i) => (
                <p key={i} className="pick-review-notice">
                  Review needed: {review.explanation}
                </p>
              ))}
              <Button variant="outline" asChild>
                <Link
                  href={liveMarketPath(
                    { platform: selected.platform, id: selected.native_id },
                    selected.catalog_provider ?? undefined,
                  )}
                >
                  View market <ArrowUpRight size={15} />
                </Link>
              </Button>
            </section>
            {reviewEnabled && (
              <section
                hidden={detailTab !== "Reason & checks"}
                className="pick-detail-section"
              >
                <PickReasonForm
                  pickId={selected.id}
                  version={selected.current_version}
                  initialReason={selected.reason}
                />
              </section>
            )}
            <section
              hidden={detailTab !== "Watch"}
              className="pick-detail-section"
            >
              <h3>Watch this market</h3>
              <p className="watch-pick-description">
                Follow price changes, rule updates and the final result in This
                week.
              </p>
              <WatchPick
                pickId={selected.id}
                version={selected.current_version}
              />
            </section>
            {detailTab === "Recap" && (
              <section className="pick-detail-section">
                <DecisionRecap pickId={selected.id} embedded />
              </section>
            )}
          </DialogContent>
        )}
      </Dialog>
    </main>
  );
}
