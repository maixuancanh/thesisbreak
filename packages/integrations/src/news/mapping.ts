type NewsItem = {
  id: string;
  url: string;
  title: string;
  text: string;
  publishedAt: string | null;
  retrievedAt: string;
  eventDate: string | null;
  teams: string[];
  player?: string | undefined;
  status?: string | undefined;
};
export const NBA_TEAMS: Record<string, { name: string; slug: string }> = {
  ATL: { name: "Atlanta Hawks", slug: "hawks" },
  BOS: { name: "Boston Celtics", slug: "celtics" },
  BKN: { name: "Brooklyn Nets", slug: "nets" },
  CHA: { name: "Charlotte Hornets", slug: "hornets" },
  CHI: { name: "Chicago Bulls", slug: "bulls" },
  CLE: { name: "Cleveland Cavaliers", slug: "cavaliers" },
  DAL: { name: "Dallas Mavericks", slug: "mavericks" },
  DEN: { name: "Denver Nuggets", slug: "nuggets" },
  DET: { name: "Detroit Pistons", slug: "pistons" },
  GSW: { name: "Golden State Warriors", slug: "warriors" },
  HOU: { name: "Houston Rockets", slug: "rockets" },
  IND: { name: "Indiana Pacers", slug: "pacers" },
  LAC: { name: "LA Clippers", slug: "clippers" },
  LAL: { name: "Los Angeles Lakers", slug: "lakers" },
  MEM: { name: "Memphis Grizzlies", slug: "grizzlies" },
  MIA: { name: "Miami Heat", slug: "heat" },
  MIL: { name: "Milwaukee Bucks", slug: "bucks" },
  MIN: { name: "Minnesota Timberwolves", slug: "timberwolves" },
  NOP: { name: "New Orleans Pelicans", slug: "pelicans" },
  NYK: { name: "New York Knicks", slug: "knicks" },
  OKC: { name: "Oklahoma City Thunder", slug: "thunder" },
  ORL: { name: "Orlando Magic", slug: "magic" },
  PHI: { name: "Philadelphia 76ers", slug: "sixers" },
  PHX: { name: "Phoenix Suns", slug: "suns" },
  POR: { name: "Portland Trail Blazers", slug: "blazers" },
  SAC: { name: "Sacramento Kings", slug: "kings" },
  SAS: { name: "San Antonio Spurs", slug: "spurs" },
  TOR: { name: "Toronto Raptors", slug: "raptors" },
  UTA: { name: "Utah Jazz", slug: "jazz" },
  WAS: { name: "Washington Wizards", slug: "wizards" },
};
export type NbaTarget = {
  eventDate: string;
  teams: string[];
  slugs?: string[];
};
/** Restricted to the inspected Kalshi NBA game contract grammar, never fuzzy titles. */
export function nbaTarget(m: {
  platform: string;
  nativeId: string;
  eventId?: string | null;
}): NbaTarget | null {
  if (m.platform !== "kalshi") return null;
  const match =
    /^(KXNBAGAME-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})([A-Z]{3})([A-Z]{3}))-([A-Z]{3})$/.exec(
      m.nativeId,
    );
  if (!match || (m.eventId && m.eventId !== match[1])) return null;
  const [, , year, month, day, a, b, side] = match;
  if (
    !a ||
    !b ||
    a === b ||
    !NBA_TEAMS[a] ||
    !NBA_TEAMS[b] ||
    (side !== a && side !== b)
  )
    return null;
  const mon = String(
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
    ].indexOf(month!) + 1,
  ).padStart(2, "0");
  const date = `20${year}-${mon}-${day}`;
  if (new Date(date + "T12:00:00Z").toISOString().slice(0, 10) !== date)
    return null;
  return {
    eventDate: date,
    teams: [NBA_TEAMS[a]!.name, NBA_TEAMS[b]!.name],
    slugs: [NBA_TEAMS[a]!.slug, NBA_TEAMS[b]!.slug],
  };
}
export function selectEvidence(items: NewsItem[], target: NbaTarget) {
  return items.filter(
    (i) =>
      i.eventDate === target.eventDate &&
      i.teams.length === 2 &&
      i.teams.every((t) => target.teams.includes(t)),
  );
}
const normalize = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
function playerName(s: string) {
  const p = s.split(",").map((x) => x.trim());
  return normalize(p.length === 2 ? `${p[1]} ${p[0]}` : s);
}
export function changedReasonFacts(
  previous: NewsItem[],
  next: NewsItem[],
  reason: string,
) {
  return next.flatMap((n) => {
    if (!n.player || !n.status) return [];
    const name = playerName(n.player);
    if (
      name.split(" ").length < 2 ||
      !` ${normalize(reason)} `.includes(` ${name} `)
    )
      return [];
    const old = previous.find(
      (p) =>
        p.player &&
        playerName(p.player) === name &&
        p.eventDate === n.eventDate &&
        JSON.stringify([...p.teams].sort()) ===
          JSON.stringify([...n.teams].sort()),
    );
    return old?.status && old.status !== n.status
      ? [{ previous: old, current: n }]
      : [];
  });
}
