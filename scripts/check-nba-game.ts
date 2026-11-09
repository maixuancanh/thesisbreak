import {
  fetchOfficialNbaGame,
  fetchOfficialNbaGameForMatch,
} from "../packages/integrations/src/news/nba-game";

// Explicit identity avoids accidentally grading a similarly named or rescheduled game.
const [
  gameId = "0042400407",
  eventDate = "2025-06-22",
  homeTeam = "OKC",
  awayTeam = "IND",
] = process.argv.slice(2);
const result =
  gameId === "match"
    ? await fetchOfficialNbaGameForMatch({ eventDate, homeTeam, awayTeam })
    : await fetchOfficialNbaGame({
        gameId,
        eventDate,
        homeTeam,
        awayTeam,
      });
console.log(JSON.stringify(result, null, 2));
if (result.state !== "available") process.exitCode = 1;
