import { fileURLToPath } from "node:url";
import { config } from "dotenv";
const root = fileURLToPath(new URL("../../", import.meta.url));
// The documented .env lives at the workspace root, while Next runs in apps/web.
// Deployment-injected variables take precedence; never expose server keys via env:{}.
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });
export default { turbopack: { root }, outputFileTracingRoot: root };
