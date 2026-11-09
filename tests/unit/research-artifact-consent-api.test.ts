import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  user: vi.fn(),
  list: vi.fn(),
  inspect: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("../../apps/web/node_modules/server-only", () => ({}));
vi.mock("pg", () => ({ Pool: class {} }));
vi.mock("../../apps/web/lib/server/auth", async () => ({
  ...(await import("../../apps/web/lib/server/auth-policy")),
  requireUser: m.user,
}));
vi.mock("../../packages/db/src/research-artifact-consent", () => ({
  listResearchArtifactConsent: m.list,
  inspectResearchArtifact: m.inspect,
  grantResearchArtifactConsent: m.grant,
  revokeResearchArtifactConsent: m.revoke,
}));
import { AuthError } from "../../apps/web/lib/server/auth";
import { researchArtifactConsentOperation } from "../../apps/web/lib/server/research-artifact-consent-service";
const id = "00000000-0000-4000-8000-000000000001",
  snapshotHash = "a".repeat(64);
function post(body: unknown, origin = "https://app.test") {
  return new Request("https://app.test/api/memory/artifacts", {
    method: "POST",
    headers: { origin },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgres://test");
  vi.stubEnv("APP_URL", "https://app.test");
  m.user.mockResolvedValue({ id: "owner" });
});
it("requires authentication before all persistence", async () => {
  m.user.mockRejectedValueOnce(new AuthError(401, "UNAUTHENTICATED"));
  expect(
    (
      await researchArtifactConsentOperation(
        new Request("https://app.test/api/memory/artifacts"),
      )
    ).status,
  ).toBe(401);
  expect(m.list).not.toHaveBeenCalled();
});
it("enforces real mutation origin and explicit confirmation", async () => {
  const input = {
    action: "grant",
    inspectionId: id,
    snapshotHash,
    confirmed: true,
  };
  expect(
    (await researchArtifactConsentOperation(post(input, "https://evil.test")))
      .status,
  ).toBe(403);
  expect(
    (
      await researchArtifactConsentOperation(
        post({ ...input, confirmed: false }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await researchArtifactConsentOperation(
        post({ ...input, reviewerId: "admin" }),
      )
    ).status,
  ).toBe(400);
  expect(m.grant).not.toHaveBeenCalled();
});
it("binds inspection, consent and revocation to authenticated owner", async () => {
  m.inspect.mockResolvedValue({ snapshotHash });
  expect(
    (
      await researchArtifactConsentOperation(
        post({
          action: "inspect",
          kind: "forecast_rationale",
          artifactId: "artifact",
        }),
      )
    ).status,
  ).toBe(200);
  expect(m.inspect).toHaveBeenCalledWith(
    expect.anything(),
    "owner",
    "forecast_rationale",
    "artifact",
  );
  m.grant.mockResolvedValue({
    id,
    consented_at: new Date(),
    snapshot_hash: snapshotHash,
  });
  const response = await researchArtifactConsentOperation(
    post({ action: "grant", inspectionId: id, snapshotHash, confirmed: true }),
  );
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(m.grant).toHaveBeenCalledWith(
    expect.anything(),
    "owner",
    expect.objectContaining({ inspectionId: id, snapshotHash }),
  );
  m.revoke.mockResolvedValue(false);
  expect(
    (
      await researchArtifactConsentOperation(
        post({ action: "revoke", grantId: id }),
      )
    ).status,
  ).toBe(404);
  expect(m.revoke).toHaveBeenCalledWith(expect.anything(), "owner", id);
});
