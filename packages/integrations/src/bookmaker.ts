import { z } from "zod";
const timestamp = z.iso.datetime({ offset: true });
const eventSchema = z.object({
  id: z.string().min(1),
  sport_key: z.literal("basketball_nba"),
  commence_time: timestamp,
  home_team: z.string().min(1),
  away_team: z.string().min(1),
  bookmakers: z
    .array(
      z.object({
        key: z.string(),
        title: z.string(),
        last_update: timestamp,
        markets: z.array(
          z.object({
            key: z.string(),
            last_update: timestamp.optional(),
            outcomes: z.array(
              z.object({ name: z.string(), price: z.number().finite().gt(1) }),
            ),
          }),
        ),
      }),
    )
    .max(100),
});
/** Canonical event candidates only. Settlement-rule equivalence still needs separate evidence. */
export function normalizeBookmakerEvent(value: unknown, now = new Date()) {
  const e = eventSchema.parse(value);
  const quotes = e.bookmakers.flatMap((b) =>
    b.markets.flatMap((m) => {
      const asOf = m.last_update ?? b.last_update;
      const age = now.getTime() - Date.parse(asOf);
      if (
        m.key !== "h2h" ||
        age < 0 ||
        age > 300000 ||
        m.outcomes.length !== 2 ||
        new Set(m.outcomes.map((o) => o.name)).size !== 2 ||
        !m.outcomes.some((o) => o.name === e.home_team) ||
        !m.outcomes.some((o) => o.name === e.away_team)
      )
        return [];
      const sum = m.outcomes.reduce((s, o) => s + 1 / o.price, 0);
      return [
        {
          bookmaker: b.key,
          title: b.title,
          asOf,
          margin: sum - 1,
          outcomes: m.outcomes.map((o) => ({
            name: o.name,
            decimalOdds: o.price,
            probability: 1 / o.price / sum,
          })),
        },
      ];
    }),
  );
  return {
    provider: "the-odds-api" as const,
    eventId: e.id,
    sport: e.sport_key,
    scheduledAt: e.commence_time,
    home: e.home_team,
    away: e.away_team,
    fetchedAt: now.toISOString(),
    rulesVerified: false as const,
    probabilityMethod: "proportional-margin-removal" as const,
    quotes,
    coverage: quotes.length ? ("observed" as const) : ("insufficient" as const),
  };
}
export class BookmakerAdapter {
  constructor(
    private readonly key: string,
    private readonly reserve: (credits: number) => Promise<void>,
    private readonly transport: typeof fetch = fetch,
  ) {
    if (typeof window !== "undefined") throw new Error("SERVER_ONLY");
    if (!key.trim()) throw new Error("BOOKMAKER_NOT_CONFIGURED");
  }
  async nba(now = new Date()) {
    await this.reserve(1); // One region and one market. Failed/uncertain calls still consume reservation.
    const u = new URL(
      "https://api.the-odds-api.com/v4/sports/basketball_nba/odds",
    );
    u.search = new URLSearchParams({
      apiKey: this.key,
      regions: "us",
      markets: "h2h",
      oddsFormat: "decimal",
      dateFormat: "iso",
    }).toString();
    let response: Response;
    try {
      response = await this.transport(u, {
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new Error("BOOKMAKER_UNAVAILABLE");
    }
    if (!response.ok)
      throw new Error(
        response.status === 401 || response.status === 403
          ? "BOOKMAKER_ACCESS_DENIED"
          : response.status === 429
            ? "BOOKMAKER_RATE_LIMITED"
            : "BOOKMAKER_UNAVAILABLE",
      );
    // Bound real stream size, not only an advisory Content-Length.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("INVALID_BOOKMAKER_RESPONSE");
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const p = await reader.read();
        if (p.done) break;
        bytes += p.value.byteLength;
        if (bytes > 2_000_000) {
          await reader.cancel();
          throw new Error("INVALID_BOOKMAKER_RESPONSE");
        }
        chunks.push(p.value);
      }
    } finally {
      reader.releaseLock();
    }
    let data: unknown;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("INVALID_BOOKMAKER_RESPONSE");
    }
    const events = z
      .array(z.unknown())
      .max(500)
      .parse(data)
      .map((r) => normalizeBookmakerEvent(r, now));
    const remaining = response.headers.get("x-requests-remaining");
    return {
      events,
      quotaRemaining:
        remaining !== null && /^\d+$/.test(remaining)
          ? Number(remaining)
          : null,
    };
  }
}
