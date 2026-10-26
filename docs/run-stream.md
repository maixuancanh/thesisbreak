Run status and cancellation
===========================

The original POST `/api/agent/messages` remains a synchronous request. It must stay alive to finish generation; there is no background worker or execution recovery after a process crash. Reconnecting recovers durable saved **status and results**, not generation execution. A stale running record is failed by the existing next-claim cleanup.

Authenticated account owners can GET `/api/agent/runs/:runId`. Foreign and unknown identifiers both return 404. Responses contain only the run ID, status, revision and schema-filtered public result; input messages, user IDs, payload hashes, provider configuration and cancellation request IDs are excluded. Failed results expose only CANCELLED or AGENT_UNAVAILABLE.

GET `/api/agent/runs/:runId/stream` returns SSE `status` events. Revision/event ID 1 is running; 2 is completed or failed. Last-Event-ID suppresses already observed revisions. A connection polls durable records every 750ms, sends comment heartbeats every five seconds, and closes after at most 24 seconds plus a bounded database read. Each reconnect authenticates the account again. Aborting/cancelling the connection clears the polling wait and request listener. This is status streaming, not model token streaming. A revoked account or database failure must reconnect/authenticate; the client eventually pauses after twelve reconnects.

POST `/api/agent/runs/:runId/cancel` requires same-origin authorization and the strict body `{ "confirmed": true, "requestId": "<UUID>", "expectedRevision": 1 }`. The UI asks for a separate explicit cancellation confirmation. The locked owner-scoped transaction changes running to failed with CANCELLED. Retrying the same request ID returns the same result. A different cancellation request or a completed/otherwise failed record returns 409 and changes nothing. Existing finishRun only commits running records, so late generation cannot overwrite cancellation.

The abort registry is a best-effort local optimization: integrate registerRunAbort(runId,userId,controller) before work; pass its signal to provider work; call unregisterRunAbort(runId,controller) in finally. A cancel on another server process still prevents durable completion, even if it cannot interrupt the remote provider request. Cancellation does not promise to reverse provider costs already incurred.

RunProgress accepts `{runId,onResult}` and reports terminal RunState through onResult. It closes EventSource on terminal/unmount and retries disconnections up to twelve times before asking the user to reconnect. Parent integration can discover an active run from saved conversation history and mount this component after navigation. Initial fresh POST still does not return an early run ID; expose a running record through existing account history if progress is needed while that request remains open.

Verification: `pnpm exec vitest run tests/unit/run-stream*.test.ts`; `node --env-file=.env node_modules/vitest/vitest.mjs run tests/integration/run-control-database.test.ts --no-file-parallelism`. Integration tests require an isolated migrated TEST_DATABASE_URL; they do not call providers.
