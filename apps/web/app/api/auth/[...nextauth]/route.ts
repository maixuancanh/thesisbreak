import NextAuth from "next-auth";
import type { NextRequest } from "next/server";
import { authConfigured, authOptions } from "../../../../lib/server/auth";
import { withAuthAvailability } from "../../../../lib/server/auth-policy";
export const runtime = "nodejs";
async function handler(
  request: NextRequest,
  context: { params: Promise<{ nextauth: string[] }> },
) {
  if (!authConfigured())
    return Response.json(
      { error: "AUTH_NOT_CONFIGURED" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  // Never derive the trusted OAuth callback host from the incoming Host header.
  process.env.NEXTAUTH_URL = process.env.APP_URL!;
  try {
    return await withAuthAvailability<Response>((reportFailure) =>
      NextAuth(authOptions(reportFailure))(request, context),
    );
  } catch {
    // Discard NextAuth cookie deletion/redirect when revocation or session lookup failed.
    return Response.json(
      { error: "AUTH_UNAVAILABLE" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
export { handler as GET, handler as POST };
