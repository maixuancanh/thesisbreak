export type TemporalRequest = {
  status: "current" | "historical" | "clarification_required";
  cutoff: Date | null;
  reason: string | null;
};
/** A date-only request has no defensible instant. Relative expressions require user clarification. */
export function parseTemporalRequest(message: string): TemporalRequest {
  const cue =
    /\b(?:as[ -]of|known (?:by|at)|before(?=\s+(?:\d{4}-|yesterday|today|last\b))|at the time of)\b|tính đến|tinh den|trước thời điểm|truoc thoi diem/iu.exec(
      message,
    );
  if (!cue) return { status: "current", cutoff: null, reason: null };
  const tail = message.slice(cue.index + cue[0].length).trim();
  const match =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(\.\d{1,3})?)?\s*(Z|UTC|[+-]\d{2}:\d{2})(?=$|[\s?.,;!])/i.exec(
      tail,
    );
  if (!match)
    return {
      status: "clarification_required",
      cutoff: null,
      reason:
        "Provide an exact date, time and timezone, for example as of 2026-10-29T12:30:00+07:00.",
    };
  const stamp = `${match[1]}T${match[2]}:${match[3] ?? "00"}${match[4] ?? ""}${/^UTC$/i.test(match[5]!) ? "Z" : match[5]}`;
  const cutoff = new Date(stamp);
  const date = match[1]!;
  const calendar = new Date(`${date}T00:00:00Z`);
  if (
    !Number.isFinite(cutoff.getTime()) ||
    calendar.toISOString().slice(0, 10) !== date ||
    Number(match[2]!.slice(0, 2)) > 23 ||
    Number(match[2]!.slice(3)) > 59 ||
    Number(match[3] ?? 0) > 59
  )
    return {
      status: "clarification_required",
      cutoff: null,
      reason: "The requested cutoff is not a valid calendar timestamp.",
    };
  return { status: "historical", cutoff, reason: null };
}
const teams = [
  ["Los Angeles Lakers", ["lakers", "lal"]],
  ["Utah Jazz", ["jazz", "uta"]],
  ["Charlotte Hornets", ["hornets", "cha"]],
  ["Washington Wizards", ["wizards", "was"]],
  ["Boston Celtics", ["celtics", "bos"]],
  ["Golden State Warriors", ["warriors", "gsw"]],
  ["New York Knicks", ["knicks", "nyk"]],
  ["Miami Heat", ["miami heat", "mia"]],
  ["Chicago Bulls", ["bulls", "chi"]],
  ["Dallas Mavericks", ["mavericks", "mavs", "dal"]],
] as const;
const normalized = (x: string) =>
  x
    .toLocaleLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const contains = (text: string, phrase: string) =>
  ` ${normalized(text)} `.includes(` ${normalized(phrase)} `);
export type AliasMarket = {
  platform: "kalshi" | "polymarket";
  nativeId: string;
  question: string;
  eventDate?: string | null;
};
export function nativeEventDate(m: AliasMarket) {
  if (m.eventDate && /^\d{4}-\d{2}-\d{2}$/.test(m.eventDate))
    return m.eventDate;
  const match =
    /^KXNBAGAME-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/i.exec(
      m.nativeId,
    );
  if (!match) return null;
  const month =
    [
      "JAN",
      "FEB",
      "MAR",
      "APR",
      "MAY",
      "JUN",
      "JUL",
      "AUG",
      "SEP",
      "OCT",
      "NOV",
      "DEC",
    ].indexOf(match[2]!.toUpperCase()) + 1;
  return `20${match[1]}-${String(month).padStart(2, "0")}-${match[3]}`;
}
/** Aliases narrow an already owner-authorized native inventory; they never create an event identity. */
export function resolveCuratedMarketAlias(
  message: string,
  markets: AliasMarket[],
) {
  const explicit = markets.filter((m) => message.includes(m.nativeId));
  if (explicit.length === 1)
    return {
      status: "matched" as const,
      market: explicit[0]!,
      candidates: explicit,
      method: "exact_native_id",
    };
  if (explicit.length > 1)
    return {
      status: "ambiguous" as const,
      market: null,
      candidates: explicit,
      method: "exact_native_id",
    };
  const mentioned = teams.filter(
    ([name, aliases]) =>
      contains(message, name) ||
      aliases.some((a) =>
        a === "was" ? /\bWAS\b/.test(message) : contains(message, a),
      ),
  );
  if (!mentioned.length)
    return {
      status: "unmatched" as const,
      market: null,
      candidates: [],
      method: "curated_alias",
    };
  const datedMessage = message.replace(
    /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|UTC|[+-]\d{2}:\d{2})/gi,
    "",
  );
  if (
    /\b(?:tomorrow|yesterday|tonight|last (?:night|week)|next (?:week|game))\b|ngày mai|hôm qua/iu.test(
      datedMessage,
    )
  )
    return {
      status: "ambiguous" as const,
      market: null,
      candidates: markets.filter((m) =>
        mentioned.every(
          ([name, aliases]) =>
            contains(m.question, name) ||
            aliases.some((a) => contains(m.question, a)),
        ),
      ),
      method: "unknown_event_date",
    };
  const dates = [
    ...new Set(datedMessage.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []),
  ];
  const candidates = markets
    .filter((m) =>
      mentioned.every(
        ([name, aliases]) =>
          contains(m.question, name) ||
          aliases.some((a) => contains(m.question, a)),
      ),
    )
    .filter(
      (m) =>
        dates.length === 0 ||
        (dates.length === 1 && nativeEventDate(m) === dates[0]),
    );
  if (candidates.length === 1)
    return {
      status: "matched" as const,
      market: candidates[0]!,
      candidates,
      method: "curated_alias",
    };
  return {
    status: candidates.length ? ("ambiguous" as const) : ("not_found" as const),
    market: null,
    candidates,
    method: "curated_alias",
  };
}
