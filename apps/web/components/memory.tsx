"use client";
import { SignInLink } from "./sign-in-link";
import { useEffect, useState, useRef } from "react";
import { z } from "zod";
import { Button } from "./ui/button";
import { LessonReview } from "./lesson-review";
import { LearningCandidates } from "./learning-candidates";
import { MemoryRecovery } from "./memory-recovery";
import { SourceHistory } from "./source-history";
import { SourceWatchCard } from "./source-watch-card";
import { WorkspaceLoading } from "./workspace-loading";
import { ResearchArtifactConsent } from "./research-artifact-consent";
import { HabitReview } from "./habit-review";
import { DropdownMenu } from "radix-ui";
import { MoreHorizontal, Search } from "lucide-react";
import { preferencePage } from "../lib/preference-list";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "./ui/dialog";
const records = z.object({
  data: z.array(
    z.object({
      lesson: z.object({
        id: z.string(),
        version: z.number(),
        rule: z.string(),
        scope: z.object({
          domain: z.string(),
          competition: z.string().optional(),
          sourceClass: z.string().optional(),
        }),
        learningCondition: z.unknown().optional(),
        status: z.string(),
      }),
      sync: z.object({
        state: z.string(),
        attempts: z.number(),
        receipt: z.unknown(),
      }),
    }),
  ),
});
type Row = z.infer<typeof records>["data"][number];
export function Memory() {
  const [rows, setRows] = useState<Row[] | null>(null),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0),
    [busy, setBusy] = useState(false);
  const [view, setView] = useState<"active" | "paused" | "retired">("active");
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const listing = preferencePage(rows ?? [], view, query, page);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [tool, setTool] = useState<"sources" | "research" | "recovery">(
    "sources",
  );
  const receipt = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    const c = new AbortController();
    setError("");
    setRows(null);
    void fetch("/api/lessons", { cache: "no-store", signal: c.signal })
      .then(async (r) => {
        if (!r.ok)
          throw new Error(
            r.status === 401
              ? "Sign in to see your remembered preferences."
              : "Account memory is unavailable. Check your connection and try again.",
          );
        const data = records.parse(await r.json());
        if (!c.signal.aborted) setRows(data.data);
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(e instanceof Error ? e.message : "Memory unavailable.");
      });
    return () => c.abort();
  }, [reload]);
  async function change(row: Row, action: "paused" | "active" | "retired") {
    if (busy) return;
    setBusy(true);
    setError("");
    const key = JSON.stringify([row.lesson.id, row.lesson.version, action]);
    if (receipt.current?.key !== key)
      receipt.current = { key, id: crypto.randomUUID() };
    try {
      const r = await fetch(
        `/api/lessons/${encodeURIComponent(row.lesson.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: receipt.current.id,
            baseVersion: row.lesson.version,
            action,
            confirmed: true,
            ...(action === "active" ? { memoryConsent: true } : {}),
          }),
        },
      );
      if (!r.ok)
        throw new Error(
          r.status === 409
            ? "This preference changed. Refresh before trying again."
            : "Could not update your preference.",
        );
      receipt.current = null;
      setReload((x) => x + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main id="main" className="page memory-page memory-consumer">
      <div className="row">
        <div>
          <p className="eyebrow">YOUR WORKSPACE</p>
          <h1>Memory</h1>
          <p className="lead">Help Thesis understand how you think.</p>
        </div>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setReload((x) => x + 1)}
        >
          Refresh
        </Button>
      </div>
      <div className="memory-intro">
        <div>
          <h2>Your way of thinking, remembered.</h2>
          <p>
            Keep the preferences you want Thesis to use in future conversations.
            You choose what stays.
          </p>
        </div>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button disabled={rows === null}>+ Add a preference</Button>
          </DialogTrigger>
          <DialogContent className="memory-dialog">
            <DialogTitle>Add a preference</DialogTitle>
            <DialogDescription>
              Tell Thesis what to keep in mind. Review it before saving.
            </DialogDescription>
            <LessonReview
              compact
              onSaved={() => {
                setReload((x) => x + 1);
                setAddOpen(false);
              }}
            />
          </DialogContent>
        </Dialog>
      </div>
      {error && (
        <div role="alert" className="connection">
          <p>{error}</p>
          {error.startsWith("Sign in") ? (
            <SignInLink>Sign in</SignInLink>
          ) : (
            <Button
              variant="outline"
              onClick={() => setReload((value) => value + 1)}
            >
              Try again
            </Button>
          )}
        </div>
      )}
      {rows === null ? (
        !error && <WorkspaceLoading label="Loading your memory" />
      ) : (
        <>
          <div className="memory-list-heading">
            <h2>Your preferences</h2>
            <p className="small muted">
              Pause a preference whenever it no longer fits.
            </p>
          </div>
          <nav className="memory-filters" aria-label="Preference status">
            {(["active", "paused", "retired"] as const).map((status) => (
              <Button
                key={status}
                variant={view === status ? "default" : "ghost"}
                aria-pressed={view === status}
                onClick={() => {
                  setView(status);
                  setPage(1);
                }}
              >
                {status === "active"
                  ? "In use"
                  : status === "paused"
                    ? "Paused"
                    : "No longer used"}{" "}
                <span className="memory-count">
                  {rows.filter((r) => r.lesson.status === status).length}
                </span>
              </Button>
            ))}
          </nav>
          <label className="memory-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search preferences"
              placeholder="Search preferences..."
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </label>
          {listing.total === 0 && query.trim() && (
            <div className="memory-empty">
              <h3>No matching preferences</h3>
              <p>Try a different phrase or category.</p>
              <Button
                variant="outline"
                onClick={() => {
                  setQuery("");
                  setPage(1);
                }}
              >
                Clear search
              </Button>
            </div>
          )}
          {!query.trim() && !rows.some((r) => r.lesson.status === view) && (
            <div className="memory-empty">
              <h3>
                {view === "active"
                  ? "Make this space yours"
                  : view === "paused"
                    ? "No paused preferences"
                    : "Nothing here yet"}
              </h3>
              <p>
                {view === "active"
                  ? "Tell Thesis what matters to you, such as waiting for an official lineup before reviewing a pick."
                  : view === "paused"
                    ? "Preferences you pause will appear here. You can use them again anytime."
                    : "Preferences you stop using stay here so you can see your history."}
              </p>
              {view === "active" && (
                <Button variant="outline" onClick={() => setAddOpen(true)}>
                  Add a preference
                </Button>
              )}
            </div>
          )}
          <div className="memory-cards" aria-label="Preferences">
            {listing.items.map((row) => {
              const result = z
                .object({
                  result: z
                    .object({
                      status: z.string(),
                      blobId: z.string().optional(),
                    })
                    .optional(),
                })
                .safeParse(row.sync.receipt);
              const verified =
                row.sync.state === "done" &&
                result.success &&
                result.data.result?.status === "verified";
              return (
                <section
                  className="memory-preference memory-preference-row"
                  key={row.lesson.id}
                >
                  <div className="memory-preference-main">
                    <p className="eyebrow">
                      {row.lesson.scope.domain}
                      {row.lesson.scope.competition
                        ? ` · ${row.lesson.scope.competition}`
                        : ""}{" "}
                    </p>
                    <Dialog>
                      <DialogTrigger asChild>
                        <button
                          className="memory-rule-preview"
                          title="Read preference"
                        >
                          {row.lesson.rule}
                        </button>
                      </DialogTrigger>
                      <DialogContent className="memory-dialog">
                        <DialogTitle>Preference</DialogTitle>
                        <DialogDescription>
                          {row.lesson.scope.domain}
                          {row.lesson.scope.competition
                            ? ` � ${row.lesson.scope.competition}`
                            : ""}
                        </DialogDescription>
                        <p className="memory-full-rule">{row.lesson.rule}</p>
                      </DialogContent>
                    </Dialog>
                    <span className="memory-save-state">
                      {verified
                        ? "Saved across sessions"
                        : row.sync.state === "not_requested"
                          ? "Updated in your account"
                          : row.sync.state === "retry"
                            ? "Sync delayed � retrying"
                            : row.sync.state === "blocked"
                              ? "Waiting to save"
                              : "Saving�"}
                    </span>
                  </div>
                  <div className="memory-row-actions">
                    {row.lesson.status !== "retired" && (
                      <Dialog
                        open={editing === row.lesson.id}
                        onOpenChange={(open) =>
                          setEditing(open ? row.lesson.id : null)
                        }
                      >
                        <DialogTrigger asChild>
                          <Button variant="outline" size="sm">
                            Edit
                          </Button>
                        </DialogTrigger>
                        <DialogContent className="memory-dialog">
                          <DialogTitle>Edit preference</DialogTitle>
                          <DialogDescription>
                            Update what Thesis should keep in mind, then review
                            your changes.
                          </DialogDescription>
                          <LessonReview
                            compact
                            domain={row.lesson.scope.domain}
                            {...(row.lesson.scope.competition
                              ? { competition: row.lesson.scope.competition }
                              : {})}
                            existing={{
                              id: row.lesson.id,
                              version: row.lesson.version,
                              rule: row.lesson.rule,
                              ...(row.lesson.scope.sourceClass
                                ? { sourceClass: row.lesson.scope.sourceClass }
                                : {}),
                              hasLearningCondition:
                                row.lesson.learningCondition != null,
                            }}
                            onSaved={() => {
                              setEditing(null);
                              setReload((x) => x + 1);
                            }}
                          />
                        </DialogContent>
                      </Dialog>
                    )}
                    {verified &&
                      result.success &&
                      result.data.result?.blobId && (
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button variant="ghost" size="sm">
                              View saved copy
                            </Button>
                          </DialogTrigger>
                          <DialogContent className="memory-dialog">
                            <DialogTitle>Saved copy</DialogTitle>
                            <DialogDescription>
                              This receipt identifies the preference saved with
                              Walrus Memory.
                            </DialogDescription>
                            <p className="small muted">
                              Stored with Walrus Memory · version{" "}
                              {row.lesson.version}. This receipt identifies the
                              saved copy.
                            </p>
                            <code className="memory-blob">
                              {result.data.result.blobId}
                            </code>
                          </DialogContent>
                        </Dialog>
                      )}
                    {row.lesson.status !== "retired" && (
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`More actions for ${row.lesson.rule}`}
                            disabled={busy}
                          >
                            <MoreHorizontal size={18} aria-hidden="true" />
                          </Button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content
                            className="menu memory-actions-menu"
                            align="end"
                            sideOffset={8}
                          >
                            <DropdownMenu.Item
                              disabled={busy}
                              onSelect={() =>
                                void change(
                                  row,
                                  row.lesson.status === "active"
                                    ? "paused"
                                    : "active",
                                )
                              }
                            >
                              {row.lesson.status === "active"
                                ? "Pause preference"
                                : "Use again"}
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                              disabled={busy}
                              onSelect={() => void change(row, "retired")}
                            >
                              Stop using
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
          {listing.total > 0 && (
            <nav className="memory-pagination" aria-label="Preference pages">
              <span aria-live="polite">
                {listing.start}-{listing.end} of {listing.total} preferences
              </span>
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={listing.page === 1}
                  onClick={() => setPage(listing.page - 1)}
                >
                  Previous
                </Button>
                <span>
                  Page {listing.page} of {listing.pages}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={listing.page === listing.pages}
                  onClick={() => setPage(listing.page + 1)}
                >
                  Next
                </Button>
              </div>
            </nav>
          )}
          <section className="panel memory-secondary">
            <h2>What you’ve learned</h2>
            <p>
              Review suggestions from your conversations and past picks. New
              lessons need your approval before Thesis uses them.
            </p>
            <Button
              variant="outline"
              aria-expanded={reviewOpen}
              aria-controls="memory-learning"
              onClick={() => setReviewOpen((x) => !x)}
            >
              {reviewOpen ? "Close suggestions" : "Review suggestions"}
            </Button>
            {reviewOpen && (
              <div id="memory-learning">
                <LearningCandidates onSaved={() => setReload((x) => x + 1)} />
                <HabitReview />
              </div>
            )}
          </section>
        </>
      )}
      {rows && (
        <section className="memory-tools">
          <Button
            variant="ghost"
            aria-expanded={toolsOpen}
            aria-controls="memory-tools"
            onClick={() => setToolsOpen((x) => !x)}
          >
            Manage sources & saved data {toolsOpen ? "−" : "+"}
          </Button>
          <p className="small muted">
            Choose what to save, manage followed sources, or recover saved
            memories.
          </p>
          {toolsOpen && (
            <div id="memory-tools" className="memory-tool-list">
              <nav className="memory-filters" aria-label="Saved data sections">
                {(
                  [
                    ["sources", "Sources you follow"],
                    ["research", "Research memory"],
                    ["recovery", "Saved data & recovery"],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    variant={tool === value ? "default" : "ghost"}
                    aria-pressed={tool === value}
                    onClick={() => setTool(value)}
                  >
                    {label}
                  </Button>
                ))}
              </nav>
              {tool === "sources" && (
                <section className="panel">
                  <h2>Sources you follow</h2>
                  <SourceHistory />
                  <SourceWatchCard />
                </section>
              )}
              {tool === "research" && (
                <section className="panel">
                  <h2>Choose which research to remember</h2>
                  <ResearchArtifactConsent />
                </section>
              )}
              {tool === "recovery" && (
                <section className="panel">
                  <h2>Saved data & recovery</h2>
                  <p className="small muted">
                    Pausing or stopping a preference changes how Thesis uses it.
                    It does not erase an existing saved copy.
                  </p>
                  <MemoryRecovery />
                </section>
              )}
            </div>
          )}
        </section>
      )}
    </main>
  );
}
