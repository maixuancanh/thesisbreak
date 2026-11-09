import { it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { watchPlans, watchPlanVersions } from "../../packages/db/src/schema";
it("ties each plan version to its exact plan owner and pick", () => {
  const plan = getTableConfig(watchPlans);
  const version = getTableConfig(watchPlanVersions);
  expect(
    plan.uniqueConstraints.some(
      (u) => u.columns.map((c) => c.name).join(",") === "id,user_id,pick_id",
    ),
  ).toBe(true);
  expect(
    version.foreignKeys.some((f) => {
      const r = f.reference();
      return (
        r.foreignTable === watchPlans &&
        r.columns.map((c) => c.name).join(",") === "plan_id,user_id,pick_id" &&
        r.foreignColumns.map((c) => c.name).join(",") === "id,user_id,pick_id"
      );
    }),
  ).toBe(true);
});
