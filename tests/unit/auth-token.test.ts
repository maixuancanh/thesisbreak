import { it, expect } from "vitest";
import { encode, decode } from "../../apps/web/lib/server/auth-codec";
it("uses NextAuth encrypted sessions and rejects tampered or expired tokens", async () => {
  const secret = "test-only-secret-".repeat(4);
  const token = await encode({
    secret,
    token: { sub: "internal-user", sid: "server-session" },
    maxAge: 60,
  });
  expect((await decode({ secret, token }))?.sub).toBe("internal-user");
  await expect(
    decode({ secret, token: token.slice(0, -8) + "tampered" }),
  ).rejects.toThrow();
  const expired = await encode({
    secret,
    token: { sub: "internal-user" },
    maxAge: -120,
  });
  await expect(decode({ secret, token: expired })).rejects.toThrow();
});
