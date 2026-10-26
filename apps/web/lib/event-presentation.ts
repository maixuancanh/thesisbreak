import { readDraft, type LiveMarket, type LiveProvider } from "./live-market";
export function marketIdentity(
  m: Pick<LiveMarket, "platform" | "id">,
  provider: LiveProvider,
) {
  return JSON.stringify([provider, m.platform, m.id]);
}
export function groupEvents(markets: LiveMarket[], provider: LiveProvider) {
  const groups = new Map<
    string,
    { key: string; title: string; markets: LiveMarket[] }
  >();
  for (const m of markets) {
    const key = JSON.stringify([
      provider,
      m.platform,
      m.eventId ? "event" : "market",
      m.eventId || m.id,
    ]);
    const group = groups.get(key) ?? {
      key,
      title: m.eventTitle || m.question,
      markets: [],
    };
    if (!group.markets.some((item) => item.id === m.id)) group.markets.push(m);
    groups.set(key, group);
  }
  return [...groups.values()];
}
export function filterMarkets(
  markets: LiveMarket[],
  query: string,
  category: string,
) {
  const needle = query.trim().toLocaleLowerCase();
  return markets.filter(
    (m) =>
      (!category || m.category === category) &&
      `${m.eventTitle ?? ""} ${m.question} ${m.conditionLabel ?? ""}`
        .toLocaleLowerCase()
        .includes(needle),
  );
}
export function validMarketDraft(raw: string | null, market: LiveMarket) {
  const draft = readDraft(raw);
  if (!draft) return null;
  return {
    ...draft,
    outcome: market.outcomes.some((o) => o.name === draft.outcome)
      ? draft.outcome
      : "",
  };
}
export function participantConditions(markets: LiveMarket[]) {
  if (
    markets.length < 2 ||
    !markets.every(
      (m) =>
        m.mutuallyExclusive === true &&
        m.marketScope === "Game" &&
        m.conditionLabel?.trim() &&
        m.outcomes.some((o) => o.name === "Yes"),
    )
  )
    return null;
  if (new Set(markets.map((m) => m.conditionLabel)).size !== markets.length)
    return null;
  return markets.map((m) => ({
    market: m,
    label: m.conditionLabel!,
    outcome: m.outcomes.find((o) => o.name === "Yes")!,
  }));
}
export function conditionTitle(m: LiveMarket) {
  return m.conditionLabel && m.conditionLabel !== m.question
    ? `${m.question} · ${m.conditionLabel}`
    : m.question;
}
export function compactDate(value: string | null | undefined) {
  return value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        timeZoneName: "short",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : null;
}

