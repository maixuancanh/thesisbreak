import { expect, it } from "vitest";
import { dueForecastHorizons } from "../../packages/integrations/src/forecast-scheduler";
it("captures only fixed pre-event windows and never backfills missed horizons", () => {
  const now = new Date("2026-10-29T00:00:00Z");
  expect(dueForecastHorizons("2026-10-29T01:00:00Z", now)).toEqual(["T60m"]);
  expect(dueForecastHorizons("2026-10-30T00:00:00Z", now)).toEqual(["T24h"]);
  expect(dueForecastHorizons("2026-10-29T00:40:00Z", now)).toEqual([]);
  expect(dueForecastHorizons("2026-10-28T23:00:00Z", now)).toEqual([]);
});
