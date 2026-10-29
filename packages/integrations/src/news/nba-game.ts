import { createHash } from "node:crypto";
import { z } from "zod";
import { boundedRead } from "./http";

const ESPN_ALIASES: Record<string, string> = {
  GS: "GSW",
  NY: "NYK",
  NO: "NOP",
  SA: "SAS",
  UTAH: "UTA",
  WSH: "WAS",
};
const canonicalTeam = (name: string) => ESPN_ALIASES[name] ?? name;
function parseNextPage(body: string): unknown {
  return JSON.parse(
    (/<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/i.exec(
      body,
    ) ?? [])[1] ?? "",
  );
}

export interface OfficialNbaMatchedGameResult extends OfficialNbaGameResult {
  scheduleProvenance: OfficialNbaProvenance | null;
  /** Explicit schedule actualEndTimeUTC, never inferred from a Final snapshot. */
  endedAt: string | null;
}
/** Resolve foreign-provider schedule IDs by exact official Eastern date and home/away tricodes. */
export async function fetchOfficialNbaGameForMatch(
  target: Omit<OfficialNbaGameTarget, "gameId">,
  options: { transport?: typeof fetch; now?: Date } = {},
): Promise<OfficialNbaMatchedGameResult> {
  const home = canonicalTeam(target.homeTeam),
    away = canonicalTeam(target.awayTeam);
  const attempts: OfficialNbaGameResult["attempts"] = [];
  const empty = (
    state: "invalid" | "unavailable",
  ): OfficialNbaMatchedGameResult => ({
    state,
    game: null,
    provenance: null,
    scheduleProvenance: null,
    endedAt: null,
    attempts,
  });
  if (
    !validTarget({ ...target, gameId: "0000000000" }) ||
    !/^[A-Z]{3}$/.test(home) ||
    !/^[A-Z]{3}$/.test(away) ||
    home === away
  )
    return empty("invalid");
  const url = `https://www.nba.com/games?date=${target.eventDate}`;
  let raw: Uint8Array;
  try {
    raw = await boundedRead(url, ["www.nba.com"], {
      ...(options.transport ? { transport: options.transport } : {}),
      maxBytes: 4_000_000,
    });
  } catch {
    attempts.push({ url, state: "unavailable" });
    return empty("unavailable");
  }
  let matched: {
    gameId: string;
    gameTimeUtc: string;
    actualEndTimeUTC?: string | null | undefined;
    homeTeam: { teamId: number };
    awayTeam: { teamId: number };
  };
  try {
    const team = z.object({
      teamTricode: z.string().regex(/^[A-Z]{3}$/),
      teamId: identifier,
    });
    const card = z.object({
      cardData: z.object({
        gameId: z.string().regex(/^\d{10}$/),
        homeTeam: team,
        awayTeam: team,
        gameTimeUtc: z.iso.datetime({ offset: true }),
        actualEndTimeUTC: z.string().nullable().optional(),
      }),
    });
    const doc = z
      .object({
        props: z.object({
          pageProps: z.object({
            hasError: z.literal(false),
            selectedDate: z.literal(target.eventDate),
            gameCardFeed: z.object({
              nextPageToken: z.null(),
              modules: z
                .array(z.object({ cards: z.array(z.unknown()).max(100) }))
                .max(30),
            }),
          }),
        }),
      })
      .parse(parseNextPage(new TextDecoder().decode(raw)));
    const matches = doc.props.pageProps.gameCardFeed.modules
      .flatMap((m) => m.cards)
      .flatMap((c) => {
        const parsed = card.safeParse(c);
        return parsed.success ? [parsed.data.cardData] : [];
      })
      .filter(
        (g) =>
          g.homeTeam.teamTricode === home && g.awayTeam.teamTricode === away,
      );
    if (matches.length !== 1) throw Error("AMBIGUOUS_OFFICIAL_GAME");
    matched = matches[0]!;
    attempts.push({ url, state: "available" });
  } catch {
    attempts.push({ url, state: "invalid" });
    return empty("invalid");
  }
  const scheduleProvenance: OfficialNbaProvenance = {
    sourceUrl: url,
    rawSha256: createHash("sha256").update(raw).digest("hex"),
    retrievedAt: (options.now ?? new Date()).toISOString(),
    sourceUpdatedAt: null,
    sourceTimestampRaw: null,
    provider: "nba_official",
    officialNba: true,
  };
  const result = await fetchOfficialNbaGame(
    {
      gameId: matched.gameId,
      eventDate: target.eventDate,
      homeTeam: home,
      awayTeam: away,
    },
    options,
  );
  // Cross-check both official snapshots, including tipoff and immutable team IDs.
  if (
    result.game &&
    (result.game.homeTeamId !== matched.homeTeam.teamId ||
      result.game.awayTeamId !== matched.awayTeam.teamId ||
      Date.parse(result.game.scheduledAt) !== Date.parse(matched.gameTimeUtc))
  )
    return {
      ...empty("invalid"),
      scheduleProvenance,
      attempts: [...attempts, ...result.attempts],
    };
  const end = matched.actualEndTimeUTC;
  const endedAt =
    result.game?.status === "final" &&
    end &&
    z.iso.datetime({ offset: true }).safeParse(end).success &&
    Date.parse(end) >= Date.parse(matched.gameTimeUtc) &&
    Date.parse(end) <= Date.parse(scheduleProvenance.retrievedAt)
      ? end
      : null;
  return {
    ...result,
    scheduleProvenance,
    endedAt,
    attempts: [...attempts, ...result.attempts],
  };
}

export interface OfficialNbaGameTarget {
  gameId: string;
  /** NBA game date (US Eastern), not the date obtained by truncating UTC tipoff. */
  eventDate: string;
  homeTeam: string;
  awayTeam: string;
}
const text = z.string().trim().min(1).max(150);
const identifier = z.number().int().positive().safe();
const playerSchema = z.object({
  personId: identifier,
  firstName: text,
  familyName: text,
  starter: z
    .union([
      z.boolean(),
      z.literal("0"),
      z.literal("1"),
      z.literal(0),
      z.literal(1),
    ])
    .optional(),
});
const teamSchema = z.object({
  teamId: identifier,
  teamTricode: z.string().regex(/^[A-Z]{3}$/),
  teamCity: text,
  teamName: text,
  score: z.number().int().min(0).max(400),
  players: z.array(playerSchema).max(30).optional(),
});
const gameSchema = z.object({
  gameId: z.string().regex(/^\d{10}$/),
  gameCode: z.string().regex(/^\d{8}\/[A-Z]{6}$/),
  gameStatus: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  gameStatusText: text,
  gameTimeUTC: z.iso.datetime({ offset: true }),
  homeTeamId: identifier.optional(),
  awayTeamId: identifier.optional(),
  homeTeam: teamSchema,
  awayTeam: teamSchema,
});
export interface OfficialNbaStarter {
  personId: number;
  name: string;
  team: string;
  starter: true;
}
export interface OfficialNbaGame {
  gameId: string;
  eventDate: string;
  scheduledAt: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamId: number;
  awayTeamId: number;
  homeScore: number;
  awayScore: number;
  status: "final" | "pending" | "live";
  /** The feeds prove final status, but provide no finalization event timestamp. */
  finalizedAt: null;
  lineupConfirmed: boolean;
  starters: OfficialNbaStarter[];
}
export interface OfficialNbaProvenance {
  sourceUrl: string;
  rawSha256: string;
  retrievedAt: string;
  /** Only an offset-qualified source meta.time; never retrieval or scheduled time. */
  sourceUpdatedAt: string | null;
  sourceTimestampRaw: string | null;
  provider: "nba_official";
  officialNba: true;
}
export interface OfficialNbaGameResult {
  state: "available" | "unavailable" | "invalid";
  game: OfficialNbaGame | null;
  provenance: OfficialNbaProvenance | null;
  attempts: { url: string; state: "available" | "unavailable" | "invalid" }[];
}

function validTarget(target: OfficialNbaGameTarget) {
  return (
    /^\d{10}$/.test(target.gameId) &&
    /^\d{4}-\d{2}-\d{2}$/.test(target.eventDate) &&
    Number.isFinite(Date.parse(target.eventDate)) &&
    new Date(target.eventDate).toISOString().slice(0, 10) ===
      target.eventDate &&
    target.homeTeam !== target.awayTeam &&
    [target.homeTeam, target.awayTeam].every((v) =>
      /^[A-Za-z .-]{2,80}$/.test(v),
    )
  );
}
function normalize(
  raw: unknown,
  target: OfficialNbaGameTarget,
): OfficialNbaGame {
  const g = gameSchema.parse(raw),
    h = g.homeTeam,
    a = g.awayTeam;
  const matches = (expected: string, t: typeof h) =>
    expected === t.teamTricode || expected === `${t.teamCity} ${t.teamName}`;
  if (
    g.gameId !== target.gameId ||
    g.gameCode !==
      `${target.eventDate.replaceAll("-", "")}/${a.teamTricode}${h.teamTricode}` ||
    !matches(target.homeTeam, h) ||
    !matches(target.awayTeam, a) ||
    h.teamId === a.teamId ||
    (g.homeTeamId !== undefined && g.homeTeamId !== h.teamId) ||
    (g.awayTeamId !== undefined && g.awayTeamId !== a.teamId)
  )
    throw Error("IDENTITY_MISMATCH");
  // Validate scheduled date against Eastern time independently of gameCode, including DST.
  const easternDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(g.gameTimeUTC));
  if (easternDate !== target.eventDate) throw Error("GAME_DATE_MISMATCH");
  if (
    g.gameStatus === 3 &&
    (!/^Final(?:\/\d*OT|\/OT)?$/i.test(g.gameStatusText) ||
      h.score === a.score ||
      h.score === 0 ||
      a.score === 0)
  )
    throw Error("INVALID_FINAL");
  if (g.gameStatus !== 3 && /^Final/i.test(g.gameStatusText))
    throw Error("CONTRADICTORY_STATUS");
  const starters: OfficialNbaStarter[] = [];
  let confirmed = true;
  const allPlayers = new Set<number>();
  for (const team of [h, a]) {
    const list = team.players ?? [];
    for (const p of list) {
      if (allPlayers.has(p.personId)) throw Error("DUPLICATE_PLAYER");
      allPlayers.add(p.personId);
    }
    const explicit = list.filter(
      (p) => p.starter === true || p.starter === "1" || p.starter === 1,
    );
    if (explicit.length !== 5) confirmed = false;
    for (const p of explicit)
      starters.push({
        personId: p.personId,
        name: `${p.firstName} ${p.familyName}`,
        team: team.teamTricode,
        starter: true,
      });
  }
  return {
    gameId: g.gameId,
    eventDate: target.eventDate,
    scheduledAt: g.gameTimeUTC,
    homeTeam: h.teamTricode,
    awayTeam: a.teamTricode,
    homeTeamId: h.teamId,
    awayTeamId: a.teamId,
    homeScore: h.score,
    awayScore: a.score,
    status:
      g.gameStatus === 3 ? "final" : g.gameStatus === 2 ? "live" : "pending",
    finalizedAt: null,
    lineupConfirmed: confirmed,
    starters: confirmed ? starters : [],
  };
}

/** Two fixed official sources; no HTML-derived URLs, redirects, credentials or external APIs.
 * NBA page positions/order and injury availability do not establish starting status.
 * Historical box-score starters establish only historical lineup, not a current forecast input.
 */
export async function fetchOfficialNbaGame(
  target: OfficialNbaGameTarget,
  options: { transport?: typeof fetch; now?: Date } = {},
): Promise<OfficialNbaGameResult> {
  const attempts: OfficialNbaGameResult["attempts"] = [];
  const empty = (state: "invalid" | "unavailable"): OfficialNbaGameResult => ({
    state,
    game: null,
    provenance: null,
    attempts,
  });
  if (!validTarget(target)) return empty("invalid");
  const urls = [
    `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${target.gameId}.json`,
    `https://www.nba.com/game/${target.gameId}/box-score`,
  ];
  for (const [index, url] of urls.entries()) {
    let raw: Uint8Array;
    try {
      raw = await boundedRead(url, ["cdn.nba.com", "www.nba.com"], {
        ...(options.transport ? { transport: options.transport } : {}),
        maxBytes: 4_000_000,
      });
    } catch {
      attempts.push({ url, state: "unavailable" });
      continue;
    }
    try {
      const body = new TextDecoder().decode(raw);
      const document: unknown =
        index === 0
          ? JSON.parse(body)
          : JSON.parse(
              (/<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/i.exec(
                body,
              ) ?? [])[1] ?? "",
            );
      const envelope = z.object({
        game: z.unknown(),
        meta: z.object({ time: z.string().max(100).optional() }).optional(),
      });
      const parsed =
        index === 0
          ? envelope.parse(document)
          : envelope.parse(
              z
                .object({ props: z.object({ pageProps: z.unknown() }) })
                .parse(document).props.pageProps,
            );
      const game = normalize(parsed.game, target);
      const stamp = parsed.meta?.time ?? null;
      const sourceUpdatedAt =
        stamp !== null &&
        z.iso.datetime({ offset: true }).safeParse(stamp).success
          ? stamp
          : null;
      attempts.push({ url, state: "available" });
      return {
        state: "available",
        game,
        provenance: {
          sourceUrl: url,
          rawSha256: createHash("sha256").update(raw).digest("hex"),
          retrievedAt: (options.now ?? new Date()).toISOString(),
          sourceUpdatedAt,
          sourceTimestampRaw: stamp,
          provider: "nba_official",
          officialNba: true,
        },
        attempts,
      };
    } catch {
      attempts.push({ url, state: "invalid" });
    }
  }
  return empty(
    attempts.some((a) => a.state === "invalid") ? "invalid" : "unavailable",
  );
}
