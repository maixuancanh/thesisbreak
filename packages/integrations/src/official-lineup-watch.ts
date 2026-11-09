import type { Pool } from "pg";
import { recordSourceWatchSnapshot } from "../../db/src/source-watches";
import {
  fetchOfficialNbaGame,
  type OfficialNbaGameResult,
  type OfficialNbaGameTarget,
} from "./news/nba-game";
export type OfficialLineupWatchTarget = {
  target: OfficialNbaGameTarget;
  personId: number;
  eventId: string;
};
/** Only normalized exact-game official adapter results can become structured lineup evidence. */
export async function recordOfficialNbaLineupSnapshot(
  pool: Pool,
  userId: string,
  watchId: string,
  result: OfficialNbaGameResult,
  input: OfficialLineupWatchTarget,
) {
  const g = result.game,
    p = result.provenance;
  if (
    result.state !== "available" ||
    !g ||
    !p ||
    !p.officialNba ||
    p.provider !== "nba_official" ||
    g.gameId !== input.target.gameId ||
    g.eventDate !== input.target.eventDate ||
    !g.lineupConfirmed ||
    !g.rosterPersonIds?.includes(input.personId)
  )
    throw Error("OFFICIAL_LINEUP_UNCONFIRMED");
  const url = new URL(p.sourceUrl);
  if (
    !["cdn.nba.com", "www.nba.com"].includes(url.hostname) ||
    !url.pathname.includes(g.gameId)
  )
    throw Error("OFFICIAL_LINEUP_PROVENANCE");
  const watch = (
    await pool.query(
      "SELECT * FROM source_watches WHERE id=$1 AND user_id=$2",
      [watchId, userId],
    )
  ).rows[0];
  if (!watch || watch.event_id !== input.eventId || watch.url !== p.sourceUrl)
    throw Error("OFFICIAL_LINEUP_WATCH_MISMATCH");
  const lineupStatus = g.starters.some(
    (player) => player.personId === input.personId,
  )
    ? ("starter" as const)
    : ("not_starter" as const);
  return recordSourceWatchSnapshot(
    pool,
    userId,
    watchId,
    {
      eventId: input.eventId,
      originId: watch.origin_id,
      url: watch.url,
      contentClass: watch.content_class,
      value: JSON.stringify({
        gameId: g.gameId,
        personId: input.personId,
        lineupStatus,
      }),
      publishedAt: p.sourceUpdatedAt,
    },
    {
      structuredEvidence: {
        subjectId: `nba-player:${input.personId}`,
        eventId: input.eventId,
        official: true,
        lineupStatus,
        sourceUrl: p.sourceUrl,
        sourceHash: p.rawSha256,
        adapterVersion: "nba-official-lineup-v1",
      },
    },
  );
}
export async function pollOfficialNbaLineupWatch(
  pool: Pool,
  userId: string,
  watchId: string,
  input: OfficialLineupWatchTarget,
  transport?: typeof fetch,
) {
  const result = await fetchOfficialNbaGame(
    input.target,
    transport ? { transport } : {},
  );
  return recordOfficialNbaLineupSnapshot(pool, userId, watchId, result, input);
}
