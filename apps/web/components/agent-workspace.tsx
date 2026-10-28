"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BookOpen,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
  ArrowLeft,
} from "lucide-react";
import { ContextualThesis } from "./contextual-thesis";
import { Button } from "./ui/button";
import { useAccountSession } from "./account-session";
import {
  fetchLivePage,
  type LiveMarket,
  type LivePlatform,
  type LiveProvider,
} from "../lib/live-market";
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
  async function newChat() {
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
      setSelected(undefined);
      router.replace(`/thesis?session=${s.id}`, { scroll: false });
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
  return (
    <main
      id="main"
      className={`thesis-workspace ${collapsed ? "sidebar-collapsed" : ""}`}
    >
      <aside className="workspace-sidebar" aria-label="Thesis workspace">
        <div className="workspace-brand">
          <strong>Thesis</strong>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse market sidebar"
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
        <nav className="session-list" aria-label="Your conversations">
          {sessions.map((s) => (
            <button
              key={s.id}
              aria-pressed={sessionId === s.id}
              onClick={() => {
                setSessionId(s.id);
                setSelected(undefined);
                router.replace(`/thesis?session=${s.id}`, { scroll: false });
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
          ))}
        </nav>
        {sessionId && sessions.some((s) => s.id === sessionId) && (
          <button
            className="session-consent"
            onClick={() => void toggleMemory()}
          >
            {sessions.find((s) => s.id === sessionId)?.memoryConsent
              ? "Pause memory for this chat"
              : "Enable memory for this chat"}
          </button>
        )}
        <p className="workspace-section-label">Find a conversation topic</p>
        <div
          className="workspace-platform"
          role="group"
          aria-label="Market source"
        >
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
        <input
          aria-label="Find a loaded market"
          placeholder="Find a market…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <nav className="workspace-market-list" aria-label="Choose a market">
          {busy && <p role="status">Loading markets…</p>}
          {error && <p role="status">{error}</p>}
          {markets
            .filter((m) =>
              (m.eventTitle + " " + m.question)
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .slice(0, 60)
            .map((m) => (
              <button
                key={m.id}
                aria-pressed={selected?.id === m.id}
                onClick={() => choose(m)}
              >
                <span>{m.eventTitle || m.question}</span>
                <small>{m.conditionLabel || m.question}</small>
              </button>
            ))}
          {!busy &&
            !error &&
            !markets.some((m) =>
              (m.eventTitle + " " + m.question)
                .toLowerCase()
                .includes(search.toLowerCase()),
            ) && <p>No matches in the loaded markets.</p>}
        </nav>
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
            aria-label="Show market sidebar"
            onClick={() => setCollapsed(false)}
          >
            <PanelLeftOpen size={18} />
          </Button>
        )}
        {status?.authenticated && !sessionId ? (
          <div className="workspace-start">
            <h1>Start a conversation.</h1>
            <p>
              One chat can cover several markets. Start a new chat anytime;
              Thesis can recall relevant memories from your earlier ones.
            </p>
            <Button onClick={() => void newChat()} disabled={sessionBusy}>
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
