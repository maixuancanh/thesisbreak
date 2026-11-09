export type PickListFilter =
  "all" | "review" | "active" | "paused" | "archived";
export function pickListPage<
  T extends {
    question: string | null;
    event_title?: string | null | undefined;
    native_id: string;
    platform: string;
    outcome: string;
    reason: string;
    state: string;
    advice_reviews?: unknown[] | undefined;
  },
>(rows: T[], filter: PickListFilter, query: string, requestedPage: number) {
  const needle = query.trim().toLocaleLowerCase();
  const matches = rows.filter(
    (p) =>
      (filter === "all" ||
        (filter === "review"
          ? Boolean(p.advice_reviews?.length)
          : filter === "active"
            ? ["active", "following"].includes(p.state)
            : p.state === filter)) &&
      (!needle ||
        [
          p.question,
          p.event_title,
          p.native_id,
          p.platform,
          p.outcome,
          p.reason,
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
          .includes(needle)),
  );
  const pages = Math.max(1, Math.ceil(matches.length / 6));
  const page = Math.min(Math.max(1, requestedPage), pages);
  const start = (page - 1) * 6;
  return {
    items: matches.slice(start, start + 6),
    total: matches.length,
    page,
    pages,
    start: matches.length ? start + 1 : 0,
    end: Math.min(start + 6, matches.length),
  };
}
