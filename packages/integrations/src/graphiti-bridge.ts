import { spawn } from "node:child_process";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { Pool } from "pg";
import { z } from "zod";
import { createPostgresMemoryIndex } from "../../db/src/memory-index";
import {
  memoryEdgeSchema,
  memoryIndexQuerySchema,
  rankMemoryEdges,
  type MemoryIndexQuery,
} from "../../domain/src/memory-index";

type Env = Readonly<Record<string, string | undefined>>;
type Request = {
  operation: "search" | "ingest";
  payload: Record<string, unknown>;
};
type Execute = (request: Request, env: Env) => Promise<Record<string, unknown>>;
type Options = { env?: Env; execute?: Execute };

/** Explicit destination and owner binding authorizes this optional external derived copy. */
export function graphitiBridgeConfig(
  env: Env,
  owner: string,
  operation: Request["operation"],
) {
  const flag =
    operation === "ingest"
      ? env.GRAPHITI_INGEST_ENABLED
      : env.GRAPHITI_SEARCH_ENABLED;
  if (
    flag !== "true" ||
    !(env.GRAPHITI_OWNER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .includes(owner)
  )
    return null;
  const url = new URL(env.GRAPHITI_DATABASE_URI ?? "");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = ["localhost", "127.0.0.1", "::1"].includes(host);
  if (
    !(env.GRAPHITI_DATABASE_HOSTS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .includes(host) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname) ||
    !["bolt:", "neo4j:", "bolt+s:", "neo4j+s:"].includes(url.protocol) ||
    (!local && !["bolt+s:", "neo4j+s:"].includes(url.protocol))
  )
    throw Error("GRAPHITI_DESTINATION_REJECTED");
  if (
    !env.GRAPHITI_DATABASE_USER ||
    !env.GRAPHITI_DATABASE_PASSWORD ||
    !env.GRAPHITI_PYTHON_PATH ||
    !isAbsolute(env.GRAPHITI_PYTHON_PATH)
  )
    throw Error("GRAPHITI_HOST_NOT_CONFIGURED");
  return { python: env.GRAPHITI_PYTHON_PATH, host };
}

/** Local process transport for the trusted separate Python environment. Secrets stay in env. */
export const executeGraphiti: Execute = async (request, env) => {
  const config = graphitiBridgeConfig(
    env,
    String(request.payload.ownerId ?? ""),
    request.operation,
  );
  if (!config) throw Error("GRAPHITI_NOT_AUTHORIZED");
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 1_000_000) throw Error("GRAPHITI_INPUT_LIMIT");
  return new Promise((resolve, reject) => {
    const graphEnv = Object.fromEntries(
      [
        "GRAPHITI_SEARCH_ENABLED",
        "GRAPHITI_INGEST_ENABLED",
        "GRAPHITI_OWNER_IDS",
        "GRAPHITI_DATABASE_URI",
        "GRAPHITI_DATABASE_HOSTS",
        "GRAPHITI_DATABASE_USER",
        "GRAPHITI_DATABASE_PASSWORD",
        "GRAPHITI_DATABASE_NAME",
      ].flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]!]])),
    );
    const child = spawn(
      config.python,
      ["-m", "thesisbreak_research.graph_cli"],
      {
        cwd:
          env.GRAPHITI_WORKER_CWD ??
          resolvePath(process.cwd(), "workers/research"),
        shell: false,
        windowsHide: true,
        env: {
          ...graphEnv,
          NODE_ENV: "production",
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot ?? "",
          PYTHONPATH: "src",
          PYTHONIOENCODING: "utf-8",
          GRAPHITI_TELEMETRY_ENABLED: "false",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "",
      done = false;
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
      } else resolve(result!);
    };
    const timer = setTimeout(
      () => finish(Error("GRAPHITI_TIMEOUT")),
      request.operation === "search" ? 12000 : 35000,
    );
    child.on("error", () => finish(Error("GRAPHITI_PROCESS_UNAVAILABLE")));
    child.stdin.on("error", () => finish(Error("GRAPHITI_PIPE_FAILED")));
    child.stderr.resume();
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > 1_000_000)
        finish(Error("GRAPHITI_OUTPUT_LIMIT"));
    });
    child.on("close", (code) => {
      if (done) return;
      try {
        const parsed = z
          .object({
            ok: z.literal(true),
            result: z.record(z.string(), z.unknown()),
          })
          .strict()
          .parse(JSON.parse(output));
        if (code !== 0) throw Error();
        finish(undefined, parsed.result);
      } catch {
        finish(Error("GRAPHITI_PROCESS_FAILED"));
      }
    });
    child.stdin.end(input);
  });
};

/** App candidate search: every graph failure/empty response preserves the scoped Postgres baseline. */
export function createConfiguredMemoryIndex(pool: Pool, options: Options = {}) {
  const env = options.env ?? process.env,
    execute = options.execute ?? executeGraphiti;
  const fallback = createPostgresMemoryIndex(pool);
  return async (raw: MemoryIndexQuery) => {
    const query = memoryIndexQuerySchema.parse(raw);
    try {
      if (graphitiBridgeConfig(env, query.ownerId, "search")) {
        const response = z
          .object({
            status: z.literal("ok"),
            items: z.array(z.unknown()).max(20),
            mode: z.literal("lexical_entity"),
            requiresRemoteReadback: z.literal(true),
          })
          .parse(await execute({ operation: "search", payload: query }, env));
        const edges = rankMemoryEdges(query, response.items);
        if (edges.length) return edges;
      }
    } catch {
      /* The optional graph cannot disable the verified local candidate path. */
    }
    return fallback(query);
  };
}

/** Consume the app's already reviewed/consented local materialization, including empty invalidation. */
export async function syncGraphitiMemoryIndex(
  pool: Pool,
  ownerId: string,
  namespace: string,
  options: Options = {},
) {
  const env = options.env ?? process.env,
    execute = options.execute ?? executeGraphiti;
  try {
    if (!graphitiBridgeConfig(env, ownerId, "ingest"))
      return { status: "disabled" as const };
    const rows = await pool.query(
      "SELECT edge FROM memory_index_edges WHERE owner_id=$1 AND namespace=$2 ORDER BY edge_id LIMIT 1001",
      [ownerId, namespace],
    );
    if (rows.rows.length > 1000) throw Error("GRAPHITI_INGEST_LIMIT");
    const edges = rows.rows.map((row) => memoryEdgeSchema.parse(row.edge));
    if (
      edges.some(
        (edge) =>
          edge.pointer.ownerId !== ownerId ||
          edge.namespace !== namespace ||
          !edge.trusted,
      )
    )
      throw Error("GRAPHITI_INGEST_AUTHORITY_MISMATCH");
    const result = z
      .object({
        status: z.literal("ok"),
        indexed: z.number().int().min(0).max(1000),
        mode: z.literal("lexical_entity"),
      })
      .parse(
        await execute(
          { operation: "ingest", payload: { ownerId, namespace, edges } },
          env,
        ),
      );
    return result;
  } catch {
    return { status: "unavailable" as const };
  }
}
