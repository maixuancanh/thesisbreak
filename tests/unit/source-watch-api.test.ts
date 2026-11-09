import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  user: vi.fn(),
  origin: vi.fn(),
  list: vi.fn(),
  state: vi.fn(),
  follow: vi.fn(),
  query: vi.fn(),
}));
vi.mock("../../apps/web/node_modules/server-only", () => ({}));
vi.mock("pg", () => ({
  Pool: class {
    query = m.query;
  },
}));
vi.mock("../../apps/web/lib/server/auth", () => ({
  requireUser: m.user,
  assertMutationOrigin: m.origin,
  AuthError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("../../packages/db/src/source-watches", () => ({
  listSourceWatches: m.list,
  setSourceWatchState: m.state,
}));
vi.mock("../../packages/integrations/src/source-watch", () => ({
  followSource: m.follow,
}));
import { sourceWatchOperation } from "../../apps/web/lib/server/source-watch-service";
import { AuthError } from "../../apps/web/lib/server/auth";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgres://test");
  m.user.mockResolvedValue({ id: "owner" });
  m.query.mockResolvedValue({ rows: [] });
});
it("authenticates before querying", async () => {
  m.user.mockRejectedValueOnce(new AuthError(401, "UNAUTHENTICATED"));
  expect(
    (
      await sourceWatchOperation(
        new Request("https://app.test/api/source-watches"),
        "list",
      )
    ).status,
  ).toBe(401);
  expect(m.list).not.toHaveBeenCalled();
});
it("returns only owner watch presentation fields, never raw snapshots or service binding", async () => {
  m.list.mockResolvedValue([
    {
      id: "watch",
      event_id: "event",
      url: "https://publisher.test/a",
      origin_id: "official",
      state: "paused",
      dependency_id: "lineup",
      sequence: 0,
      snapshot_value: "private",
      service_watch_id: "secret",
    },
  ]);
  const r = await sourceWatchOperation(
    new Request("https://app.test/api/source-watches"),
    "list",
  );
  expect(m.list).toHaveBeenCalledWith(expect.anything(), "owner");
  expect(await r.text()).not.toMatch(
    /private|secret|snapshot_value|service_watch_id/,
  );
  expect(r.headers.get("cache-control")).toBe("no-store");
});
it("rejects cross origin mutations before parsing or persistence", async () => {
  m.origin.mockImplementationOnce(() => {
    throw new AuthError(403, "ORIGIN_FORBIDDEN");
  });
  expect(
    (
      await sourceWatchOperation(
        new Request("https://app.test/api/source-watches", { method: "POST" }),
        "create",
      )
    ).status,
  ).toBe(403);
  expect(m.follow).not.toHaveBeenCalled();
});
it("owner scopes pause and hides foreign or unknown ids", async () => {
  m.state.mockResolvedValue(null);
  const id = "00000000-0000-4000-8000-000000000001";
  const r = await sourceWatchOperation(
    new Request("https://app.test/api/source-watches", {
      method: "PATCH",
      body: JSON.stringify({ state: "paused" }),
    }),
    "update",
    id,
  );
  expect(r.status).toBe(404);
  expect(m.state).toHaveBeenCalledWith(
    expect.anything(),
    "owner",
    id,
    "paused",
  );
});
