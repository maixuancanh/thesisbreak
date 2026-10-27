import { describe, expect, it } from "vitest";
import { safeReturnTo, signInPath } from "../../apps/web/lib/auth-navigation";

describe("sign-in return navigation", () => {
  it("keeps an internal event and its provider query", () => {
    const path = "/live-market/kalshi/GAME?provider=public";
    expect(safeReturnTo(path)).toBe(path);
    expect(
      new URL(signInPath(path), "https://app.test").searchParams.get(
        "returnTo",
      ),
    ).toBe(path);
  });
  it.each([
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "/%2f%2fevil.test",
    "/api/auth/signout",
    "/account?returnTo=/account",
    "javascript:alert(1)",
    "/picks\n",
  ])("rejects unsafe or looping destinations: %s", (path) => {
    expect(safeReturnTo(path)).toBe("/");
  });
  it("uses discovery when no destination is supplied", () => {
    expect(safeReturnTo(null)).toBe("/");
  });
  it("accepts NextAuth's absolute callback only for the current origin", () => {
    expect(safeReturnTo("https://app.test/memory", "https://app.test")).toBe(
      "/memory",
    );
    expect(safeReturnTo("https://evil.test/memory", "https://app.test")).toBe(
      "/",
    );
    expect(safeReturnTo("https://app.test/account", "https://app.test")).toBe(
      "/",
    );
  });
});
