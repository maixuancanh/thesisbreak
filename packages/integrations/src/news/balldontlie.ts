import { boundedRead } from "./http";
type State =
  | "available"
  | "unavailable"
  | "invalid"
  | "unconfigured"
  | "access_required"
  | "rate_limited"
  | "partial";
type Item = {
  id: string;
  url: string;
  title: string;
  text: string;
  publishedAt: string | null;
  retrievedAt: string;
  eventDate: string | null;
  teams: string[];
  player?: string;
  status?: string;
};
type Result = {
  source: "balldontlie";
  state: State;
  items: Item[];
  detail?: string;
};
const HOST = "api.balldontlie.io";
const object = (x: unknown): Record<string, unknown> => {
  if (!x || typeof x !== "object" || Array.isArray(x))
    throw new Error("INVALID");
  return x as Record<string, unknown>;
};
const id = (x: unknown): number => {
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x <= 0)
    throw new Error("INVALID");
  return x;
};
const str = (x: unknown): string => {
  if (typeof x !== "string" || !x.trim() || x.length > 10000)
    throw new Error("INVALID");
  return x;
};
const date = (x: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(x) &&
  Number.isFinite(Date.parse(x)) &&
  new Date(x).toISOString().slice(0, 10) === x;
/** Official NBA OpenAPI: games free; injuries/lineups require appropriate paid access.
 * A single selected feed avoids probing paid endpoints on the five-request free tier.
 * Injuries are current snapshots, not game-specific reports; no published date is invented.
 */
export async function fetchBallDontLie(
  target: { eventDate: string; teams: string[] },
  options: {
    apiKey?: string;
    transport?: typeof fetch;
    now?: Date;
    features?: "games" | "injuries" | "lineups";
  } = {},
): Promise<Result> {
  const items: Item[] = [];
  const result = (state: State, detail?: string): Result => ({
    source: "balldontlie",
    state,
    items,
    ...(detail ? { detail } : {}),
  });
  const feature = options.features ?? "games";
  if (
    !date(target.eventDate) ||
    target.teams.length !== 2 ||
    target.teams.some((x) => !x.trim()) ||
    target.teams[0] === target.teams[1] ||
    !["games", "injuries", "lineups"].includes(feature)
  )
    return result("invalid", "Invalid NBA target or feature");
  const key = options.apiKey ?? process.env.BALLDONTLIE_API_KEY;
  if (!key?.trim())
    return result("unconfigured", "BALLDONTLIE_API_KEY is not configured");
  const retrievedAt = (options.now ?? new Date()).toISOString();
  let active = "games";
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (
      url.protocol !== "https:" ||
      url.hostname !== HOST ||
      url.port ||
      url.username ||
      url.password
    )
      throw new Error("INVALID");
    return (options.transport ?? fetch)(url, {
      ...init,
      headers: { Authorization: key },
    });
  };
  const read = async (url: URL) => {
    const raw = await boundedRead(url.href, [HOST], {
      transport,
      maxBytes: 2_000_000,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new Error("INVALID");
    }
    const body = object(parsed);
    if (!Array.isArray(body.data)) throw new Error("INVALID");
    return {
      data: body.data as unknown[],
      cursor: body.meta === undefined ? null : object(body.meta).next_cursor,
    };
  };
  try {
    const gamesUrl = new URL(`https://${HOST}/nba/v1/games`);
    gamesUrl.searchParams.set("dates[]", target.eventDate);
    gamesUrl.searchParams.set("per_page", "100");
    const games = await read(gamesUrl);
    if (games.cursor !== undefined && games.cursor !== null)
      throw new Error("INVALID");
    const matches = games.data.map(object).filter((g) => {
      const h = object(g.home_team),
        v = object(g.visitor_team);
      return (
        g.date === target.eventDate &&
        target.teams.includes(String(h.full_name)) &&
        target.teams.includes(String(v.full_name)) &&
        h.full_name !== v.full_name
      );
    });
    if (matches.length !== 1)
      return result("invalid", "No unique exact-date two-team NBA game");
    const game = matches[0]!;
    const gameId = id(game.id);
    const home = object(game.home_team),
      away = object(game.visitor_team);
    const teamMap = new Map([
      [id(home.id), str(home.full_name)],
      [id(away.id), str(away.full_name)],
    ]);
    if (teamMap.size !== 2) throw new Error("INVALID");
    const status = str(game.status);
    items.push({
      id: `bdl:game:${gameId}`,
      url: gamesUrl.href,
      title: `${home.full_name} vs ${away.full_name}`,
      text: `NBA game ${target.eventDate}: ${home.full_name} vs ${away.full_name}. Status: ${status}.`,
      publishedAt: null,
      retrievedAt,
      eventDate: target.eventDate,
      teams: [...target.teams],
      status,
    });
    if (feature === "games")
      return result(
        "available",
        "games available; injuries and lineups were not requested",
      );
    active = feature;
    const endpoint = feature === "injuries" ? "player_injuries" : "lineups";
    const base = new URL(`https://${HOST}/nba/v1/${endpoint}`);
    base.searchParams.set("per_page", "100");
    if (feature === "injuries")
      for (const teamId of teamMap.keys())
        base.searchParams.append("team_ids[]", String(teamId));
    else base.searchParams.set("game_ids[]", String(gameId));
    const seen = new Set<number>();
    const seenItems = new Set<string>();
    for (let page = 0; page < 4; page++) {
      const body = await read(base);
      const pageItems: Item[] = [];
      for (const value of body.data) {
        const row = object(value),
          p = object(row.player);
        const playerId = id(p.id),
          teamId = id(p.team_id);
        const teamName = teamMap.get(teamId);
        if (!teamName) throw new Error("INVALID");
        const player = `${str(p.first_name)} ${str(p.last_name)}`;
        let status: string;
        let itemId: string;
        let text: string;
        if (feature === "lineups") {
          const team = object(row.team);
          if (
            id(row.game_id) !== gameId ||
            id(team.id) !== teamId ||
            str(team.full_name) !== teamName ||
            typeof row.starter !== "boolean"
          )
            throw new Error("INVALID");
          itemId = `bdl:lineup:${id(row.id)}`;
          status = row.starter ? "starter" : "bench";
          text = `${player}: ${status} for ${teamName} in NBA game ${gameId} (${target.eventDate}).`;
        } else {
          status = str(row.status);
          itemId = `bdl:injury:${playerId}`;
          const description =
            row.description === null ? "" : str(row.description);
          const returnDate =
            row.return_date === null ? "" : str(row.return_date);
          text = `Current injury snapshot: ${player}, ${teamName}: ${status}. ${description}${returnDate ? ` Return date reported: ${returnDate}.` : ""} This record has no game date or publication timestamp.`;
        }
        if (seenItems.has(itemId)) throw new Error("INVALID");
        seenItems.add(itemId);
        pageItems.push({
          id: itemId,
          url: base.href,
          title: `${player}: ${status}`,
          text,
          publishedAt: null,
          retrievedAt,
          eventDate: feature === "lineups" ? target.eventDate : null,
          teams: [teamName],
          player,
          status,
        });
      }
      items.push(...pageItems);
      if (body.cursor === undefined || body.cursor === null)
        return result(
          "available",
          `${feature} available${body.data.length === 0 ? "; empty response makes no player availability claim" : ""}`,
        );
      const cursor = id(body.cursor);
      if (seen.has(cursor)) throw new Error("INVALID");
      seen.add(cursor);
      base.searchParams.set("cursor", String(cursor));
    }
    return result(
      "partial",
      `${feature}: bounded pagination stopped after four pages`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return result(
      message === "INVALID"
        ? "invalid"
        : message === "SOURCE_ACCESS_REQUIRED"
          ? "access_required"
          : message === "SOURCE_RATE_LIMITED"
            ? "rate_limited"
            : "unavailable",
      `${active}: ${message === "SOURCE_ACCESS_REQUIRED" ? "API key or subscription access required" : message === "SOURCE_RATE_LIMITED" ? "rate limited" : message === "INVALID" ? "invalid source response" : "source request failed"}`,
    );
  }
}
