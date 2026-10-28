"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { SignInLink } from "./sign-in-link";
import {
  ArrowUp,
  BookOpen,
  ChevronDown,
  Maximize2,
  Minimize2,
  MessageCircle,
  Bookmark,
  Copy,
  History,
  ArrowUpRight,
} from "lucide-react";
import { conditionTitle } from "../lib/event-presentation";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { AgentPickDraft } from "./agent-pick-draft";
import { AgentProposal } from "./agent-proposal";
import { AgentReply } from "./agent-reply";
import {
  researchResult,
  transcriptRows,
  messageIdentity,
  toolNames,
} from "../lib/agent-client";
import { z } from "zod";
import { LivePickForm } from "./live-pick-form";
import { LessonReview } from "./lesson-review";
import { RunProgress, type RunState } from "./run-progress";
import { IndependentEvidence } from "./independent-evidence";
import { ReasonReview } from "./reason-review";
import { ResearchBriefing } from "./research-briefing";
import {
  draftKey,
  readDraft,
  liveMarketPath,
  type LiveMarket,
  type LiveProvider,
} from "../lib/live-market";

export function ContextualThesis({
  market,
  provider,
  initialOutcome = "",
  sessionId,
  onCompleted,
}: {
  market?: LiveMarket | undefined;
  provider: LiveProvider;
  initialOutcome?: string | undefined;
  sessionId?: string | undefined;
  onCompleted?: (() => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <aside
      className={cn("thesis-panel agent-studio", expanded && "agent-expanded")}
      aria-label="Thesis panel"
    >
      <header className="agent-header">
        <div className="agent-name">
          <span className="agent-avatar">
            <MessageCircle size={18} />
          </span>
          <div>
            <h2>Thesis</h2>
            <p>Your thinking partner</p>
          </div>
        </div>
        <div className="agent-tools">
          <Button asChild variant="ghost" size="icon">
            <Link
              href="/memory"
              aria-label="What Thesis remembers"
              title="What Thesis remembers"
            >
              <BookOpen size={17} />
            </Link>
          </Button>
          {market && (
            <Button asChild variant="ghost" size="icon">
              <Link
                href={`/thesis?${new URLSearchParams({ platform: market.platform, id: market.id, provider, ...(sessionId ? { session: sessionId } : {}) })}`}
                aria-label="Open Thesis workspace"
                title="Open workspace"
              >
                <ArrowUpRight size={17} />
              </Link>
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={expanded ? "Restore agent panel" : "Expand agent panel"}
            aria-pressed={expanded}
            onClick={() => setExpanded((x) => !x)}
          >
            {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </Button>
        </div>
      </header>
      <StudioConversation
        key={
          sessionId ??
          (market ? draftKey(market.platform, market.id, provider) : "welcome")
        }
        market={market}
        provider={provider}
        initialOutcome={initialOutcome}
        sessionId={sessionId}
        onCompleted={onCompleted}
      />
    </aside>
  );
}
function StudioConversation({
  market,
  provider,
  initialOutcome,
  sessionId,
  onCompleted,
}: {
  market: LiveMarket | undefined;
  provider: LiveProvider;
  initialOutcome: string;
  sessionId?: string | undefined;
  onCompleted?: (() => void) | undefined;
}) {
  const key = sessionId
    ? `thesisbreak.session.${sessionId}`
    : market
      ? draftKey(market.platform, market.id, provider)
      : "thesisbreak.studio.general";
  const [composer, setComposer] = useState("");
  const localSession = useRef(sessionId);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [rememberInline, setRememberInline] = useState(true);
  const [review, setReview] = useState(false);
  const [showHistory, setShowHistory] = useState(false),
    [copied, setCopied] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const [available, setAvailable] = useState(false);
  const [checkingConnection, setCheckingConnection] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [owner, setOwner] = useState("");
  const [rows, setRows] = useState<ReturnType<typeof transcriptRows>>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [historyReady, setHistoryReady] = useState(false);
  const [running, setRunning] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const pending = useRef<{ text: string; requestId: string } | null>(null);
  const pendingComparison = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const c = new AbortController();
    void fetch("/api/agent/status", { signal: c.signal, cache: "no-store" })
      .then(async (r) => {
        const state = await r.json();
        if (c.signal.aborted) return;
        setAvailable(r.ok && state.configured === true);
        setSignedIn(state.authenticated === true);
        setOwner(typeof state.userId === "string" ? state.userId : "");
        if (sessionId && state.authenticated) {
          const h = await fetch(
            sessionId
              ? `/api/agent/sessions/history?sessionId=${sessionId}`
              : `/api/agent/history?platform=${market!.platform}&id=${encodeURIComponent(market!.id)}`,
            { signal: c.signal, cache: "no-store" },
          );
          if (!h.ok)
            throw new Error(
              "Conversation could not be loaded. Refresh before sending.",
            );
          const loaded = transcriptRows(await h.json());
          if (!c.signal.aborted) {
            setRows(loaded);
            const active = loaded.find((r) => r.status === "running");
            if (active) setRunning({ id: active.id, message: active.message });
            setHistoryReady(true);
          }
        } else setHistoryReady(true);
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setFailure(e instanceof Error ? e.message : "Thesis is unavailable.");
      })
      .finally(() => {
        if (!c.signal.aborted) setCheckingConnection(false);
      });
    return () => {
      c.abort();
      controller.current?.abort();
    };
  }, [key]);
  useEffect(() => {
    if (rows.length) end.current?.scrollIntoView({ block: "nearest" });
  }, [rows.length, busy]);
  useEffect(() => {
    if (!busy || !localSession.current || running) return;
    const c = new AbortController();
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void fetch(
        localSession.current
          ? `/api/agent/sessions/history?sessionId=${localSession.current}`
          : `/api/agent/history?platform=${market!.platform}&id=${encodeURIComponent(market!.id)}`,
        { cache: "no-store", signal: c.signal },
      )
        .then(async (r) => {
          if (!r.ok) return;
          const rows = transcriptRows(await r.json());
          const active = rows.find(
            (r) =>
              r.status === "running" && r.message === pending.current?.text,
          );
          if (active && !c.signal.aborted)
            setRunning({ id: active.id, message: active.message });
        })
        .catch(() => {})
        .finally(() => {
          polling = false;
        });
    }, 1200);
    return () => {
      c.abort();
      clearInterval(timer);
    };
  }, [busy, key, running, market, sessionRevision]);
  async function send(compareMemory = false) {
    if (
      (!market && !sessionId) ||
      !available ||
      !signedIn ||
      !historyReady ||
      busy ||
      !!running ||
      !composer.trim()
    )
      return;
    const message = composer.trim();
    setBusy(true);
    setFailure("");
    const active = new AbortController();
    controller.current = active;
    const receiptKey = `${key}:send:${encodeURIComponent(owner)}${compareMemory ? ":comparison" : ""}`;
    if (pendingComparison.current !== compareMemory) pending.current = null;
    pendingComparison.current = compareMemory;
    try {
      const status = await fetch("/api/agent/status", {
        signal: active.signal,
        cache: "no-store",
      });
      const account = await status.json();
      if (!status.ok || !account.authenticated || account.userId !== owner) {
        setRows([]);
        setSignedIn(false);
        throw new Error(
          "Your account changed. Sign in and reopen this conversation.",
        );
      }
      try {
        const old = z
          .object({ text: z.string().max(4000), requestId: z.uuid() })
          .strict()
          .safeParse(JSON.parse(sessionStorage.getItem(receiptKey) ?? "null"));
        if (old.success) pending.current = old.data;
      } catch {}
      pending.current = messageIdentity(pending.current, message, () =>
        crypto.randomUUID(),
      );
      try {
        sessionStorage.setItem(receiptKey, JSON.stringify(pending.current));
      } catch {}
      if (!localSession.current) {
        const created = await fetch("/api/agent/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: active.signal,
          body: JSON.stringify({ memoryConsent: rememberInline }),
        });
        if (!created.ok)
          throw Error("Couldn’t start your conversation. Try again.");
        localSession.current = (await created.json()).id;
        setSessionRevision((n) => n + 1);
      }
      const response = await fetch("/api/agent/sessions/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.any([active.signal, AbortSignal.timeout(240000)]),
        body: JSON.stringify({
          ...(market ? { platform: market.platform, nativeId: market.id } : {}),
          provider,
          ...(localSession.current ? { sessionId: localSession.current } : {}),
          message,
          requestId: pending.current.requestId,
          ...(compareMemory ? { compareMemory: true } : {}),
        }),
      });
      const payload = await response.json();
      if (response.ok && payload.status === "completed") {
        onCompleted?.();
        if (!onCompleted)
          void fetch("/api/agent/sessions/sync", { method: "POST" }).catch(
            () => {},
          );
      }
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? "Another reply is still being prepared, or your request changed. Retry shortly."
            : "Thesis couldn't finish this request. Your message is kept; retry to check its status.",
        );
      if (payload.status === "running") {
        setRunning({ id: payload.runId, message });
        return;
      }
      if (payload.status !== "completed") {
        pending.current = null;
        sessionStorage.removeItem(receiptKey);
        throw new Error(
          "Thesis couldn't complete that request. Send again to try a new run.",
        );
      }
      const result = researchResult.parse(payload.result);
      const freshStatus = await fetch("/api/agent/status", {
        signal: active.signal,
        cache: "no-store",
      });
      const freshAccount = await freshStatus.json();
      if (
        !freshStatus.ok ||
        !freshAccount.authenticated ||
        freshAccount.userId !== owner
      ) {
        setRows([]);
        setSignedIn(false);
        throw new Error(
          "Your account changed. Reopen this conversation to load its history.",
        );
      }
      setRows((previous) => [
        ...previous.filter((r) => r.id !== payload.runId),
        {
          id: payload.runId,
          message,
          status: "completed",
          result,
          created_at: new Date().toISOString(),
        },
      ]);
      setRunning(null);
      setFailure("");
      pending.current = null;
      try {
        sessionStorage.removeItem(receiptKey);
      } catch {}
      edit("");
    } catch (e) {
      if (!active.signal.aborted)
        setFailure(
          e instanceof Error
            ? e.message
            : "Thesis is unavailable. Your draft is kept.",
        );
    } finally {
      if (!active.signal.aborted) setBusy(false);
    }
  }

  async function resumed(state: RunState) {
    if (!running || state.runId !== running.id) return;
    const status = await fetch("/api/agent/status", { cache: "no-store" });
    const account = await status.json();
    if (!status.ok || !account.authenticated || account.userId !== owner) {
      setRows([]);
      setSignedIn(false);
      setRunning(null);
      return;
    }
    if (state.status === "completed") {
      const parsed = researchResult.safeParse(state.result);
      if (parsed.success) {
        onCompleted?.();
        setFailure("");
        setRows((previous) => [
          ...previous.filter((r) => r.id !== state.runId),
          {
            id: state.runId,
            message: running.message,
            status: "completed",
            result: parsed.data,
            created_at: new Date().toISOString(),
          },
        ]);
      } else
        setFailure(
          "Saved reply could not be loaded. Refresh this conversation.",
        );
    } else
      setFailure(
        (state.result as { error?: string } | null)?.error === "CANCELLED"
          ? "Research cancelled. Your draft is kept."
          : "Research failed. Your draft is kept.",
      );
    pending.current = null;
    try {
      sessionStorage.removeItem(
        `${key}:send:${encodeURIComponent(owner)}${pendingComparison.current ? ":comparison" : ""}`,
      );
    } catch {}
    setRunning(null);
  }

  useEffect(() => {
    try {
      setComposer(readDraft(sessionStorage.getItem(key))?.composer ?? "");
    } catch {}
  }, [key]);
  function edit(value: string) {
    setComposer(value);
    try {
      const old = readDraft(sessionStorage.getItem(key));
      sessionStorage.setItem(
        key,
        JSON.stringify({
          outcome: old?.outcome ?? "",
          reason: old?.reason ?? "",
          composer: value,
        }),
      );
    } catch {}
  }
  const prompts = market
    ? ["Explain this event", "Challenge my pick", "What should I watch?"]
    : [
        "Help me understand a market",
        "How do I build a better pick?",
        "What can you help me with?",
      ];
  return (
    <>
      {rows.length > 0 && (
        <div className="agent-thread-toolbar">
          <span>
            {rows.length} {rows.length === 1 ? "exchange" : "exchanges"} in this
            {localSession.current ? " conversation" : " chat"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={showHistory}
            onClick={() => setShowHistory((v) => !v)}
          >
            <History size={14} />
            History
          </Button>
        </div>
      )}
      {showHistory && (
        <nav
          className="agent-thread-history"
          aria-label="Messages in this conversation"
        >
          {rows.map((row, i) => (
            <button
              key={row.id}
              onClick={() => {
                document
                  .getElementById(`run-${row.id}`)
                  ?.scrollIntoView({ block: "start", behavior: "instant" });
                setShowHistory(false);
              }}
            >
              {i + 1}. {row.message}
            </button>
          ))}
        </nav>
      )}
      {market && (
        <div className="agent-market">
          <div>
            <span className="agent-context-label">Discussing</span>
            <h3>{market.eventTitle || market.question}</h3>
            <p>{conditionTitle(market)}</p>
          </div>
          <Link
            className="agent-details"
            href={liveMarketPath(
              market,
              provider === "tatum"
                ? "tatum"
                : market.platform === "kalshi"
                  ? "kalshi-public"
                  : "polymarket-public",
            )}
          >
            Details
          </Link>
        </div>
      )}
      {market && (
        <IndependentEvidence
          key={`${market.platform}:${market.id}:${provider}`}
          platform={market.platform}
          nativeId={market.id}
          provider={provider}
        />
      )}
      <div className="agent-conversation">
        {market && (
          <ResearchBriefing
            platform={market.platform}
            nativeId={market.id}
            provider={provider}
            signedIn={signedIn}
            refreshKey={
              rows.filter((row) => row.status === "completed").at(-1)?.id ?? ""
            }
          />
        )}
        {!rows.length && (
          <>
            <div className="agent-intro">
              <span className="agent-intro-mark">
                <MessageCircle size={25} />
              </span>
              <h3>
                {market && !checkingConnection && !signedIn
                  ? "Your research, remembered."
                  : market
                    ? "What's your take?"
                    : "Meet Thesis."}
              </h3>
              <p>
                {market && !checkingConnection && !signedIn
                  ? "Sign in to talk with Thesis, revisit your reasoning and carry what you learn into the next event."
                  : market
                    ? "Bring your view. Explore the evidence, question your assumptions, and decide what matters."
                    : "Choose a market from Discover or the sidebar. I’ll help you understand the odds, test your reasoning and learn from the result."}
              </p>
              {market && !checkingConnection && !signedIn && (
                <Button asChild>
                  <SignInLink>Sign in to chat</SignInLink>
                </Button>
              )}
            </div>
            {(signedIn || !market) && (
              <div className="agent-starters">
                {prompts.map((text) => (
                  <button
                    key={text}
                    type="button"
                    disabled={busy || !!running}
                    onClick={() => {
                      edit(text);
                      input.current?.focus();
                    }}
                  >
                    {text}
                    <span aria-hidden="true">↗</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {rows.map((row) => (
          <div className="agent-turn" key={row.id} id={`run-${row.id}`}>
            <div className="agent-user-message">
              <span>You</span>
              <p>{row.message}</p>
              {row.result?.marketQuestion && (
                <small>{row.result.marketQuestion}</small>
              )}
            </div>
            {row.result && (
              <div className="agent-assistant-message">
                <span>Thesis</span>
                <AgentReply text={row.result.reply.message} />
                {row.result.memoryComparison && (
                  <details className="agent-used-memory">
                    <summary>See what memory changed</summary>
                    {row.result.memoryComparison.status === "compared" ? (
                      <>
                        <h4>With your approved preferences</h4>
                        <p>{row.result.memoryComparison.withMemory.message}</p>
                        <h4>Without those preferences</h4>
                        <p>
                          {row.result.memoryComparison.withoutMemory.message}
                        </p>
                        <p className="small muted">
                          Same event and sources; previous chat excluded from
                          both replies. Different wording does not establish a
                          better prediction.
                        </p>
                      </>
                    ) : (
                      <p>No approved preferences apply to this event yet.</p>
                    )}
                  </details>
                )}
                {row.result.sources.length > 0 && (
                  <div className="agent-citations">
                    {row.result.sources.map((source, i) => (
                      <a
                        key={source.id}
                        href={source.url || undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        [{i + 1}]{" "}
                        {source.id === "market-source"
                          ? "Market record"
                          : source.id === "final-settlement"
                            ? "Final result"
                            : source.id.startsWith("news:nba-official:")
                              ? "NBA report"
                              : source.id.startsWith("news:team-official:")
                                ? "Official team news"
                                : source.id.startsWith("news:fed-official:")
                                  ? "Federal Reserve"
                                  : source.id.startsWith("news:balldontlie:")
                                    ? "NBA data"
                                    : "Saved snapshot"}
                      </a>
                    ))}
                  </div>
                )}
                {((row.result.marketQuestion !== "General conversation" &&
                  !row.result.marketRef) ||
                  (market &&
                    row.result.marketRef?.platform === market.platform &&
                    row.result.marketRef?.nativeId === market.id)) && (
                  <ReasonReview
                    result={row.result}
                    runId={row.id}
                    domain={market?.category ?? "unclassified"}
                    {...(market?.competition
                      ? { competition: market.competition }
                      : {})}
                  />
                )}
                {!!row.result.recalledSources?.length && (
                  <details className="agent-used-memory">
                    <summary>Track records behind this reply</summary>
                    {row.result.recalledSources.map((s) => (
                      <p key={s.id}>
                        {s.sourceName}: {s.performance.matched}/
                        {s.performance.scored} matched final results.{" "}
                        {s.performance.scored < 5
                          ? "Too few results to judge reliability."
                          : "Past results do not guarantee the next outcome."}{" "}
                      </p>
                    ))}
                  </details>
                )}
                {row.result.usedLessons.length > 0 && (
                  <details className="agent-used-memory">
                    <summary>
                      Remembered {row.result.usedLessons.length} of your
                      preferences
                    </summary>
                    {row.result.usedLessons.map((l) => (
                      <p key={l.id}>{l.rule}</p>
                    ))}
                  </details>
                )}
                <details className="agent-trace">
                  <summary>What Thesis checked</summary>
                  {row.result.trace.map((t) => (
                    <p key={t.tool}>
                      {toolNames[t.tool] ?? t.tool}:{" "}
                      {t.status === "unavailable"
                        ? "unavailable"
                        : `${t.count} result(s)`}
                    </p>
                  ))}
                  <p>
                    {row.result.memoryState === "walrus_recalled"
                      ? "Walrus recall checked against your current approved records."
                      : row.result.memoryState === "account_only"
                        ? "Preferences came from your account; Walrus is not connected."
                        : "No preference lookup used on this turn."}
                  </p>
                </details>
                <div className="agent-reply-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Copy Thesis reply"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(row.result!.reply.message)
                        .then(() => setCopied(row.id))
                        .catch(() => setCopied("failed"));
                    }}
                  >
                    <Copy size={14} />
                    {copied === row.id ? "Copied" : "Copy"}
                  </Button>
                  {copied === "failed" && (
                    <span role="status">
                      Couldn’t copy. Select the text to copy it.
                    </span>
                  )}
                </div>
                {!!row.result.sessionMemories?.length && (
                  <details className="agent-used-memory">
                    <summary>
                      Remembered from {row.result.sessionMemories.length}{" "}
                      earlier conversation(s)
                    </summary>
                    {row.result.sessionMemories.map((m) => (
                      <p key={m.sessionId}>
                        <Link href={`/thesis?session=${m.sessionId}`}>
                          {m.payload.title}
                        </Link>
                        <small>
                          {" "}
                          · Walrus ·{" "}
                          {new Date(m.recordedAt).toLocaleDateString()} ·
                          version {m.version}
                        </small>
                      </p>
                    ))}
                  </details>
                )}
                {!!row.result.plannedTools?.length && (
                  <details className="agent-trace">
                    <summary>Research steps chosen</summary>
                    {row.result.plannedTools.map((t) => (
                      <p key={t}>{toolNames[t] ?? t}</p>
                    ))}
                  </details>
                )}
                {((row.result.marketQuestion !== "General conversation" &&
                  !row.result.marketRef) ||
                  (market &&
                    row.result.marketRef?.platform === market.platform &&
                    row.result.marketRef?.nativeId === market.id)) && (
                  <AgentProposal result={row.result} />
                )}
                {market && row.id === rows.at(-1)?.id && (
                  <div
                    className="agent-followups"
                    aria-label="Continue this conversation"
                  >
                    <span>Keep exploring</span>
                    {(market.resolution
                      ? [
                          "Which evidence mattered most?",
                          "What should I learn from this result?",
                        ]
                      : [
                          "What evidence could change this view?",
                          "Which sources should I trust here?",
                        ]
                    ).map((question) => (
                      <button
                        key={question}
                        disabled={busy || !!running}
                        onClick={() => {
                          edit(question);
                          input.current?.focus();
                        }}
                      >
                        {question}
                        <span aria-hidden="true">↗</span>
                      </button>
                    ))}
                  </div>
                )}
                {market &&
                  ((row.result.marketQuestion !== "General conversation" &&
                    !row.result.marketRef) ||
                    (row.result.marketRef?.platform === market.platform &&
                      row.result.marketRef?.nativeId === market.id)) && (
                    <details className="agent-used-memory">
                      <summary>Teach Thesis for next time</summary>
                      <LessonReview
                        domain={market.category ?? "unclassified"}
                        {...(market.competition
                          ? { competition: market.competition }
                          : {})}
                        sourceRunId={row.id}
                      />
                    </details>
                  )}
                {market &&
                  ((row.result.marketQuestion !== "General conversation" &&
                    !row.result.marketRef) ||
                    (row.result.marketRef?.platform === market.platform &&
                      row.result.marketRef?.nativeId === market.id)) &&
                  row.result.reply.proposedPick && (
                    <AgentPickDraft
                      draft={row.result.reply.proposedPick}
                      market={market}
                      provider={provider}
                    />
                  )}
              </div>
            )}
            {row.status === "failed" && (
              <p className="small muted">
                This request did not complete. You can try it again.
              </p>
            )}
          </div>
        ))}
        {running && (
          <RunProgress
            runId={running.id}
            onResult={(state) => void resumed(state)}
          />
        )}
        {busy && (
          <p role="status" className="agent-working">
            Thesis is checking the context and preparing a reply…
          </p>
        )}
        {failure && (
          <p role="alert" className="agent-error">
            {failure}
          </p>
        )}
        <div ref={end} />
        {market && signedIn && (
          <div className="agent-pick-action">
            <Button
              variant="outline"
              onClick={() => setReview((x) => !x)}
              aria-expanded={review}
              aria-controls="agent-pick-review"
            >
              <Bookmark size={15} />
              {review ? "Hide pick" : "Review pick"}
              <ChevronDown size={14} />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !!running || !signedIn}
              onClick={() => {
                edit(
                  "Review my saved reason against the latest supplied evidence. Separate supported, contradicted and unresolved assumptions. Do not change my pick.",
                );
                input.current?.focus();
              }}
            >
              Review my reason
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !!running || !signedIn}
              onClick={() => {
                edit(
                  "Review the final result and my saved reasoning. Separate outcome from reasoning quality and suggest a cautious lesson for me to review, only if the evidence justifies it. Do not change my pick or save a lesson.",
                );
                input.current?.focus();
              }}
            >
              Learn from this result
            </Button>
          </div>
        )}
        {market && review && (
          <div id="agent-pick-review" className="agent-review">
            <LivePickForm
              market={market}
              provider={provider}
              initialOutcome={initialOutcome}
              compact
            />
          </div>
        )}
      </div>
      {(signedIn || checkingConnection || !market) && (
        <div className="agent-compose-area">
          <div className="agent-compose-box">
            <label className="sr-only" htmlFor="studio-composer">
              Message Thesis
            </label>
            <textarea
              ref={input}
              id="studio-composer"
              value={composer}
              disabled={busy || !!running}
              maxLength={4000}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  if (
                    (market || sessionId) &&
                    available &&
                    signedIn &&
                    historyReady &&
                    !busy &&
                    !running &&
                    composer.trim()
                  )
                    void send();
                }
              }}
              onChange={(e) => edit(e.target.value)}
              placeholder="Talk it through with Thesis…"
            />
            <div className="agent-compose-footer">
              <span>Enter to send · Shift+Enter for a new line</span>
              <Button
                size="icon"
                disabled={
                  (!market && !sessionId) ||
                  !available ||
                  !signedIn ||
                  !historyReady ||
                  busy ||
                  !!running ||
                  !composer.trim()
                }
                onClick={() => void send()}
                aria-label={busy ? "Preparing reply" : "Send message"}
                aria-describedby="studio-availability"
              >
                <ArrowUp size={19} />
              </Button>
            </div>
          </div>
          {!sessionId && signedIn && (
            <label className="session-consent">
              <input
                type="checkbox"
                checked={rememberInline}
                disabled={!!localSession.current || busy}
                onChange={(e) => setRememberInline(e.target.checked)}
              />
              Remember this chat with Walrus
            </label>
          )}
          {!sessionId && localSession.current && (
            <Link
              className="text-link small"
              href={`/thesis?session=${localSession.current}`}
            >
              Continue in workspace
            </Link>
          )}
          {market && signedIn && available && (
            <button
              type="button"
              className="text-link small"
              disabled={busy || !!running || !historyReady || !composer.trim()}
              onClick={() => void send(true)}
            >
              See how memory changes the reply
            </button>
          )}
          <p id="studio-availability" className="agent-availability">
            {!market ? (
              "Ask a question, or choose a market from the sidebar."
            ) : checkingConnection ? (
              "Connecting to Thesis…"
            ) : !signedIn ? (
              <SignInLink
                returnTo={liveMarketPath(market) + `?provider=${provider}`}
              >
                Sign in to chat with Thesis
              </SignInLink>
            ) : !available ? (
              "Thesis is temporarily unavailable. Your draft is kept here."
            ) : (
              "Replies use this event, your conversation and the sources checked."
            )}
          </p>
        </div>
      )}
    </>
  );
}
