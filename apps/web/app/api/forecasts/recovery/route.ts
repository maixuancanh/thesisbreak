import { Pool } from "pg";
import {
  requireUser,
  AuthError,
  assertMutationOrigin,
} from "../../../../lib/server/auth";
import { readNbaForecastInventory } from "../../../../../../packages/db/src/forecast-ledger";
import {
  MemwalAdapter,
  officialMemwalClient,
  parseMemwalConfig,
} from "../../../../../../packages/integrations/src/memwal";
export const runtime = "nodejs";
export const maxDuration = 120;
export async function POST(request: Request) {
  let pool: Pool | undefined, adapter: MemwalAdapter | undefined;
  try {
    assertMutationOrigin(request);
    const user = await requireUser();
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const inventory = await readNbaForecastInventory(pool, user.id);
    adapter = new MemwalAdapter(
      officialMemwalClient(parseMemwalConfig(process.env)),
      user.id,
    );
    const restored = await adapter.restore(inventory.records);
    return Response.json(
      {
        expectedRecords: inventory.expectedRecords,
        truncated: inventory.truncated,
        completeness: restored.completeness,
        permissionsRestored: false,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return Response.json(
      { error: e instanceof AuthError ? e.message : "RECOVERY_UNAVAILABLE" },
      { status: e instanceof AuthError ? e.status : 503 },
    );
  } finally {
    adapter?.destroy();
    await pool?.end();
  }
}
