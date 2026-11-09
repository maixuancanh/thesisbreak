import { expect, it } from "vitest";
import { deploymentReadiness } from "../../packages/domain/src/deployment-readiness";

const config = {
  APP_URL: "https://example.com",
  DATABASE_URL: "postgres://private",
  AUTH_SECRET: "private",
  AUTH_GOOGLE_ID: "private",
  AUTH_GOOGLE_SECRET: "private",
  LLM_BASE_URL: "https://model.example/v1",
  LLM_API_KEY: "private",
  LLM_MODEL: "model",
  MEMWAL_ACCOUNT_ID: "private",
  MEMWAL_DELEGATE_KEY: "private",
};
it("requires production configuration before checking the database", async () => {
  let queried = false;
  expect(
    await deploymentReadiness({}, async () => {
      queried = true;
    }),
  ).toEqual({ status: "unavailable" });
  expect(queried).toBe(false);
  expect(
    await deploymentReadiness(
      { ...config, LLM_BASE_URL: "http://localhost:34158/v1" },
      async () => {},
    ),
  ).toEqual({ status: "unavailable" });
});
it("checks the schema and returns no provider or database errors", async () => {
  expect(await deploymentReadiness(config, async () => {})).toEqual({
    status: "ready",
  });
  const failed = await deploymentReadiness(config, async () => {
    throw new Error("postgres://private password");
  });
  expect(failed).toEqual({ status: "unavailable" });
});
