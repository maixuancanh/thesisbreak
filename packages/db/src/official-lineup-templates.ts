import type { PoolClient } from "pg";
import { z } from "zod";
import { nbaTarget, NBA_TEAMS } from "../../integrations/src/news/mapping";
import type { ReasonCondition } from "../../domain/src/pick-reason";
const official = z.object({
  state: z.literal("available"),
  game: z.object({
    gameId: z.string().regex(/^\d{10}$/),
    eventDate: z.string(),
    scheduledAt: z.iso.datetime({ offset: true }),
    homeTeam: z.string(),
    awayTeam: z.string(),
    lineupConfirmed: z.literal(true),
    starters: z
      .array(
        z.object({
          personId: z.number().int().positive(),
          name: z.string().min(1),
          team: z.string(),
          starter: z.literal(true),
        }),
      )
      .length(10),
    rosterPersonIds: z.array(z.number().int().positive()).optional(),
  }),
  provenance: z.object({
    sourceUrl: z.url(),
    rawSha256: z.string().regex(/^[a-f0-9]{64}$/),
    retrievedAt: z.iso.datetime({ offset: true }),
    provider: z.literal("nba_official"),
    officialNba: z.literal(true),
  }),
});
export async function availableOfficialLineupTemplates(
  c: Pick<PoolClient, "query">,
  pick: { platform: string; native_id: string; event_id: string | null },
  now: Date,
) {
  const mapped = nbaTarget({
    platform: pick.platform,
    nativeId: pick.native_id,
    eventId: pick.event_id,
  });
  if (!mapped) return [];
  const snapshots = (
    await c.query(
      "SELECT source_url,payload FROM nba_public_snapshots WHERE source_url LIKE 'https://cdn.nba.com/%' OR source_url LIKE 'https://www.nba.com/game/%' ORDER BY retrieved_at DESC LIMIT 100",
    )
  ).rows;
  const seen = new Set<string>();
  const templates = [];
  for (const row of snapshots) {
    const sourceGameId = /(?:boxscore_|\/game\/)(\d{10})/.exec(
      row.source_url,
    )?.[1];
    if (sourceGameId && seen.has(sourceGameId)) continue;
    if (sourceGameId) seen.add(sourceGameId);
    const parsed = official.safeParse(row.payload);
    if (!parsed.success) continue;
    const { game: g, provenance: p } = parsed.data;
    const url = new URL(p.sourceUrl);
    const teams = [g.homeTeam, g.awayTeam].map((t) => NBA_TEAMS[t]?.name ?? t);
    if (
      g.eventDate !== mapped.eventDate ||
      !teams.every((t) => mapped.teams.includes(t)) ||
      row.source_url !== p.sourceUrl ||
      !["cdn.nba.com", "www.nba.com"].includes(url.hostname) ||
      !url.pathname.includes(g.gameId) ||
      Date.parse(g.scheduledAt) <= now.getTime() ||
      Date.parse(p.retrievedAt) > now.getTime() ||
      now.getTime() - Date.parse(p.retrievedAt) > 86400000
    )
      continue;

    for (const player of g.starters) {
      const eventId = pick.event_id ?? `${pick.platform}:${pick.native_id}`;
      const target = {
        target: {
          gameId: g.gameId,
          eventDate: g.eventDate,
          homeTeam: g.homeTeam,
          awayTeam: g.awayTeam,
        },
        personId: player.personId,
        eventId,
      };
      const condition: ReasonCondition = {
        kind: "official_lineup",
        subjectId: `nba-player:${player.personId}`,
        eventIds: [eventId],
        statement: `${player.name} starts in the official lineup.`,
        revisitWhen: `${player.name} is not in the official starting lineup.`,
        predicate: {
          type: "lineup_status",
          expected: "starter",
          revisitOn: "not_starter",
        },
        sourcePolicy: "official_required",
        validFrom: now.toISOString(),
        validUntil: new Date(
          Date.parse(g.scheduledAt) + 86400000,
        ).toISOString(),
      };
      templates.push({
        id: `official:${g.gameId}:${player.personId}`,
        label: `Watch ${player.name}'s official lineup`,
        condition,
        target,
        sourceUrl: p.sourceUrl,
        sourceHash: p.rawSha256,
      });
    }
  }
  return templates;
}
