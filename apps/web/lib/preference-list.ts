export const PREFERENCES_PER_PAGE = 6;
export function preferencePage<
  T extends {
    lesson: {
      status: string;
      rule: string;
      scope: { domain: string; competition?: string | undefined };
    };
  },
>(rows: T[], status: string, query: string, requestedPage: number) {
  const needle = query.trim().toLocaleLowerCase();
  const matches = rows.filter(
    ({ lesson }) =>
      lesson.status === status &&
      (!needle ||
        [lesson.rule, lesson.scope.domain, lesson.scope.competition ?? ""]
          .join(" ")
          .toLocaleLowerCase()
          .includes(needle)),
  );
  const pages = Math.max(1, Math.ceil(matches.length / PREFERENCES_PER_PAGE));
  const page = Math.min(Math.max(1, requestedPage), pages);
  const offset = (page - 1) * PREFERENCES_PER_PAGE;
  return {
    items: matches.slice(offset, offset + PREFERENCES_PER_PAGE),
    total: matches.length,
    pages,
    page,
    start: matches.length ? offset + 1 : 0,
    end: Math.min(offset + PREFERENCES_PER_PAGE, matches.length),
  };
}
