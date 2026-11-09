"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Tabs } from "radix-ui";
import {
  BookOpen,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
  ArrowLeft,
  Search,
} from "lucide-react";
import { ContextualThesis } from "./contextual-thesis";
import { Button } from "./ui/button";
import { PagedList } from "./paged-list";
import { useAccountSession } from "./account-session";
import { cn } from "../lib/utils";
import {
  fetchLivePage,
  type LiveMarket,
  type LivePlatform,
  type LiveProvider,
} from "../lib/live-market";

const shortWorkspace = "(max-height: 620px)";

function subscribeToWorkspaceHeight(onChange: () => void) {
  const media = window.matchMedia(shortWorkspace);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function isShortWorkspace() {
  return window.matchMedia(shortWorkspace).matches;
}

export function AgentWorkspace({
  initialSessionId,
  initialPlatform,
  initialId,
  provider,
}: {
  initialSessionId?: string | undefined;
  initialPlatform: LivePlatform;
  initialId: string;
  provider: LiveProvider;
}) {
  const router = useRouter();
  const { status } = useAccountSession();
  const compact = useSyncExternalStore(
    subscribeToWorkspaceHeight,
    isShortWorkspace,
    () => false,
  );
  const pageSize = compact ? 2 : 3;
  const [sessionId, setSessionId] = useState(initialSessionId),
    [sessions, setSessions] = useState<
      {
        id: string;
        title: string;
        memoryConsent: boolean;
        memoryState: string | null;
      }[]
    >([]),
    [sessionError, setSessionError] = useState(""),
    [remember, setRemember] = useState(true),
    [sessionBusy, setSessionBusy] = useState(false);
  async function loadSessions() {
    const r = await fetch("/api/agent/sessions", { cache: "no-store" });
    if (r.ok) setSessions((await r.json()).data);
  }
  useEffect(() => {
    if (status?.authenticated) void loadSessions();
    else setSessions([]);
  }, [status]);
  useEffect(() => {
    setSessionId(initialSessionId);
  }, [initialSessionId]);
  async function newChat(market?: LiveMarket) {
    setSessionBusy(true);
    setSessionError("");
    try {
      const r = await fetch("/api/agent/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memoryConsent: remember }),
      });
      if (!r.ok) throw Error("Couldn’t create a chat. Sign in and try again.");
      const s = await r.json();
      setSessionId(s.id);
      setSelected(market);
      if (window.innerWidth < 761) setCollapsed(true);
      const query = new URLSearchParams({ session: s.id });
      if (market) {
        query.set("platform", market.platform);
        query.set("id", market.id);
        query.set("provider", provider);
      }
      router.replace(`/thesis?${query}`, { scroll: false });
      await loadSessions();
    } catch (e) {
      setSessionError((e as Error).message);
    } finally {
      setSessionBusy(false);
    }
  }
  async function toggleMemory() {
    const current = sessions.find((s) => s.id === sessionId);
    if (!current) return;
    setSessionError("");
    try {
      const r = await fetch("/api/agent/sessions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: current.id,
          memoryConsent: !current.memoryConsent,
        }),
      });
      if (!r.ok) throw Error("Couldn’t update memory. Try again.");
      await loadSessions();
    } catch (e) {
      setSessionError((e as Error).message);
    }
  }
  async function completed() {
    void loadSessions();
    try {
      await fetch("/api/agent/sessions/sync", { method: "POST" });
      await loadSessions();
    } catch {
      /* Durable checkpoint remains queued. */
    }
  }

  const [platform, setPlatform] = useState(initialPlatform),
    [markets, setMarkets] = useState<LiveMarket[]>([]),
    [selected, setSelected] = useState<LiveMarket>(),
    [search, setSearch] = useState(""),
    [chatSearch, setChatSearch] = useState(""),
    [sidebarTab, setSidebarTab] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    setBusy(true);
    setError("");
    setMarkets([]);
    void fetchLivePage(
      new URLSearchParams({ platform, provider, limit: "20" }),
      c.signal,
    )
      .then((p) => {
        if (!c.signal.aborted) setMarkets(p.data);
      })
      .catch(() => {
        if (!c.signal.aborted)
          setError(
            "Markets couldn’t be loaded. Try the other source or return to Discover.",
          );
      })
      .finally(() => {
        if (!c.signal.aborted) setBusy(false);
      });
    return () => c.abort();
  }, [platform, provider]);
  useEffect(() => {
    if (!initialId) {
      setSelected(undefined);
      return;
    }
    const c = new AbortController();
    void fetchLivePage(
      new URLSearchParams({
        platform: initialPlatform,
        provider,
        id: initialId,
      }),
      c.signal,
    )
      .then((p) => {
        if (!c.signal.aborted)
          setSelected(p.data.find((m) => m.id === initialId));
      })
      .catch(() => {
        if (!c.signal.aborted)
          setError(
            "This market couldn’t be opened. Choose another from the list.",
          );
      });
    return () => c.abort();
  }, [initialPlatform, initialId, provider]);
  function choose(m: LiveMarket) {
    setSelected(m);
    router.replace(
      `/thesis?${new URLSearchParams({ platform: m.platform, id: m.id, provider, ...(sessionId ? { session: sessionId } : {}) })}`,
      { scroll: false },
    );
    if (window.innerWidth < 761) setCollapsed(true);
  }
  const currentSession = sessions.find((s) => s.id === sessionId);
  const chatQuery = chatSearch.trim().toLowerCase();
  const marketQuery = search.trim().toLowerCase();
  const visibleSessions = sessions.filter((s) =>
    s.title.toLowerCase().includes(chatQuery),
  );
  const visibleMarkets = markets.filter((m) =>
    [m.eventTitle, m.question, m.conditionLabel].some((value) =>
      value?.toLowerCase().includes(marketQuery),
    ),
  );
  return (
    <main
      id="main"
      className={cn("thesis-workspace", collapsed && "sidebar-collapsed")}
    >
      <aside className="workspace-sidebar" aria-label="Thesis workspace">
        <div className="workspace-brand">
          <strong>Thesis</strong>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse Thesis sidebar"
          >
            <PanelLeftClose size={17} />
          </Button>
        </div>
        <Button
          variant="outline"
          className="workspace-new"
          onClick={() => void newChat()}
          disabled={!status?.authenticated || sessionBusy}
        >
          <Plus size={16} /> {sessionBusy ? "Creating…" : "New chat"}
        </Button>
        <label className="session-consent">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          Remember new chats with Walrus
        </label>
        {sessionError && <p role="alert">{sessionError}</p>}
        <Tabs.Root
          className="workspace-browser"
          value={
            sidebarTab ??
            (initialId || status?.authenticated === false ? "markets" : "chats")
          }
          onValueChange={setSidebarTab}
        >
          <Tabs.List className="workspace-tabs" aria-label="Browse Thesis">
            <Tabs.Trigger value="chats">Your chats</Tabs.Trigger>
            <Tabs.Trigger value="markets">Markets</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="chats" className="workspace-tab-content" forceMount>
            {sessions.length > 0 && (
              <label className="workspace-search">
                <Search size={15} aria-hidden="true" />
                <input
                  type="search"
                  aria-label="Find a chat"
                  placeholder="Find a chat…"
                  value={chatSearch}
                  onChange={(e) => setChatSearch(e.target.value)}
                />
              </label>
            )}
            <PagedList
              key={chatQuery}
              items={visibleSessions}
              size={pageSize}
              label="Chat pages"
              className="workspace-list"
            >
              {(s) => (
                <button
                  key={s.id}
                  title={s.title}
                  aria-pressed={sessionId === s.id}
                  onClick={() => {
                    setSessionId(s.id);
                    setSelected(undefined);
                    router.replace(`/thesis?session=${s.id}`, { scroll: false });
                    if (window.innerWidth < 761) setCollapsed(true);
                  }}
                >
                  <span>{s.title}</span>
                  <small>
                    {!s.memoryConsent
                      ? "Memory off"
                      : s.memoryState === "verified"
                        ? "Memory saved"
                        : s.memoryState === "retry"
                          ? "Memory will retry"
                          : s.memoryState
                            ? "Saving memory…"
                            : "No memory yet"}
                  </small>
                </button>
              )}
            </PagedList>
            {!visibleSessions.length && (
              <p className="workspace-list-note">
                {!status
                  ? "Loading chats…"
                  : !status.authenticated
                    ? "Sign in to see your chats."
                    : sessions.length
                      ? "No matching chats."
                      : "Your chats will appear here."}
              </p>
            )}
            {currentSession && (
              <Button
                variant="ghost"
                size="sm"
                className="workspace-memory-toggle"
                onClick={() => void toggleMemory()}
              >
                {currentSession.memoryConsent
                  ? "Pause memory for this chat"
                  : "Enable memory for this chat"}
              </Button>
            )}
          </Tabs.Content>
          <Tabs.Content value="markets" className="workspace-tab-content" forceMount>
            <div className="workspace-platform" role="group" aria-label="Market source">
              {(["kalshi", "polymarket"] as const).map((p) => (
                <button
                  key={p}
                  aria-pressed={platform === p}
                  onClick={() => setPlatform(p)}
                >
                  {p === "kalshi" ? "Kalshi" : "Polymarket"}
                </button>
              ))}
            </div>
            <label className="workspace-search">
              <Search size={15} aria-hidden="true" />
              <input
                aria-label="Find a loaded market"
                placeholder="Find a market…"
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            {busy && <p className="workspace-list-note" role="status">Loading markets…</p>}
            {error && <p className="workspace-list-note" role="status">{error}</p>}
            <PagedList
              key={`${platform}:${marketQuery}`}
              items={visibleMarkets}
              size={pageSize}
              label="Market pages"
              className="workspace-list"
            >
              {(m) => (
                <button
                  key={m.id}
                  title={m.eventTitle && m.eventTitle !== m.question
                    ? `${m.eventTitle} — ${m.question}`
                    : m.question}
                  aria-pressed={selected?.platform === m.platform && selected.id === m.id}
                  onClick={() => choose(m)}
                >
                  <span>{m.eventTitle || m.question}</span>
                  <small>{m.conditionLabel || m.question}</small>
                </button>
              )}
            </PagedList>
            {!busy && !error && !visibleMarkets.length && (
              <p className="workspace-list-note">No matching markets.</p>
            )}
          </Tabs.Content>
        </Tabs.Root>
        <div className="workspace-sidebar-footer">
          <Link href="/memory">
            <BookOpen size={16} />
            What Thesis remembers
          </Link>
          <Link href="/">
            <ArrowLeft size={15} />
            Back to markets
          </Link>
        </div>
      </aside>
      <section className="workspace-chat" aria-label="Conversation workspace">
        {collapsed && (
          <Button
            className="workspace-reopen"
            variant="ghost"
            size="icon"
            aria-label="Show Thesis sidebar"
            onClick={() => setCollapsed(false)}
          >
            <PanelLeftOpen size={18} />
          </Button>
        )}
        {status?.authenticated && !sessionId ? (
          <div className="workspace-start">
            <h1>{selected?.eventTitle || selected?.question || "Start a conversation."}</h1>
            <p>{selected
              ? (selected.eventTitle !== selected.question && selected.eventTitle
                  ? selected.question
                  : "Start a chat about this market.")
              : "Ask about a market, compare sources, or revisit a pick. Thesis can bring relevant context from earlier chats."}</p>
            <Button className="workspace-primary" onClick={() => void newChat(selected)} disabled={sessionBusy}>
              New chat
            </Button>
          </div>
        ) : (
          <ContextualThesis
            market={selected}
            provider={provider}
            sessionId={sessionId}
            onCompleted={() => void completed()}
          />
        )}
      </section>
    </main>
  );
}
