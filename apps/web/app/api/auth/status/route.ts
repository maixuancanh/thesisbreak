import { authConfigured, getAccountProfile } from "../../../../lib/server/auth";
export const runtime = "nodejs";
export async function GET() {
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
  if (!authConfigured())
    return Response.json(
      { configured: false, authenticated: false },
      { status: 503, headers },
    );
  try {
    const user = await getAccountProfile();
    const profile = user ? { name: user.name, email: user.email } : null;
    return Response.json(
      {
        configured: true,
        authenticated: Boolean(user),
        userId: user?.id ?? null,
        profile,
      },
      { headers },
    );
  } catch {
    return Response.json(
      { configured: true, authenticated: false, error: "AUTH_UNAVAILABLE" },
      { status: 503, headers },
    );
  }
}
