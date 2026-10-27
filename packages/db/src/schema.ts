import { sql } from "drizzle-orm";
import {
  pgTable,
  date,
  boolean,
  text,
  integer,
  timestamp,
  jsonb,
  primaryKey,
  unique,
  foreignKey,
  check,
  index,
} from "drizzle-orm/pg-core";
const time = (n: string) => timestamp(n, { withTimezone: true, mode: "date" });
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  providerSubject: text("provider_subject").notNull().unique(),
  createdAt: time("created_at").notNull().defaultNow(),
});
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: time("expires_at").notNull(),
  revokedAt: time("revoked_at"),
});
export const markets = pgTable(
  "markets",
  {
    platform: text("platform").notNull(),
    nativeId: text("native_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.platform, t.nativeId] }),
    check("platform_allowed", sql`${t.platform} IN ('polymarket','kalshi')`),
  ],
);
export const marketSnapshots = pgTable(
  "market_snapshots",
  {
    id: text("id").primaryKey(),
    platform: text("platform").notNull(),
    nativeId: text("native_id").notNull(),
    eventId: text("event_id"),
    question: text("question").notNull(),
    outcomes: jsonb("outcomes").notNull(),
    rulesReference: text("rules_reference").notNull(),
    rulesHash: text("rules_hash").notNull(),
    closeTime: time("close_time"),
    fetchedAt: time("fetched_at").notNull(),
    priceAsOf: time("price_as_of"),
    nativeUnit: text("native_unit").notNull(),
    raw: jsonb("raw").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.platform, t.nativeId],
      foreignColumns: [markets.platform, markets.nativeId],
    }),
  ],
);
export const picks = pgTable(
  "picks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    nativeId: text("native_id").notNull(),
    currentVersion: integer("current_version").notNull().default(1),
    state: text("state").notNull().default("following"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.id, t.userId),
    foreignKey({
      columns: [t.platform, t.nativeId],
      foreignColumns: [markets.platform, markets.nativeId],
    }),
    check("pick_version_positive", sql`${t.currentVersion}>0`),
  ],
);
export const pickVersions = pgTable(
  "pick_versions",
  {
    pickId: text("pick_id").notNull(),
    userId: text("user_id").notNull(),
    version: integer("version").notNull(),
    parentVersion: integer("parent_version"),
    snapshotId: text("snapshot_id").references(() => marketSnapshots.id),
    outcome: text("outcome").notNull(),
    reason: text("reason"),
    assumptions: jsonb("assumptions").notNull().default([]),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.pickId, t.version] }),
    unique().on(t.pickId, t.userId, t.version),
    foreignKey({
      columns: [t.pickId, t.userId],
      foreignColumns: [picks.id, picks.userId],
      name: "pick_version_owner_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.pickId, t.parentVersion],
      foreignColumns: [t.pickId, t.version],
      name: "pick_parent_fk",
    }),
    check(
      "pick_ancestry",
      sql`(${t.version}=1 AND ${t.parentVersion} IS NULL) OR (${t.version}>1 AND ${t.parentVersion} IS NOT NULL AND ${t.parentVersion}=${t.version}-1)`,
    ),
  ],
);
export const watchPlans = pgTable(
  "watch_plans",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pickId: text("pick_id").notNull(),
    currentVersion: integer("current_version").notNull().default(1),
  },
  (t) => [
    unique().on(t.id, t.userId),
    unique().on(t.id, t.userId, t.pickId),
    foreignKey({
      columns: [t.pickId, t.userId],
      foreignColumns: [picks.id, picks.userId],
    }).onDelete("cascade"),
  ],
);
export const watchPlanVersions = pgTable(
  "watch_plan_versions",
  {
    planId: text("plan_id").notNull(),
    userId: text("user_id").notNull(),
    version: integer("version").notNull(),
    parentVersion: integer("parent_version"),
    pickId: text("pick_id").notNull(),
    pickVersion: integer("pick_version").notNull(),
    condition: jsonb("condition").notNull(),
    sourceIds: jsonb("source_ids").notNull(),
    procedureVersion: text("procedure_version").notNull(),
    deadline: time("deadline").notNull(),
    timezone: text("timezone").notNull(),
    channel: text("channel").notNull(),
    approvedAt: time("approved_at"),
    state: text("state").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.planId, t.version] }),
    foreignKey({
      columns: [t.planId, t.userId, t.pickId],
      foreignColumns: [watchPlans.id, watchPlans.userId, watchPlans.pickId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.pickId, t.userId, t.pickVersion],
      foreignColumns: [
        pickVersions.pickId,
        pickVersions.userId,
        pickVersions.version,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.planId, t.parentVersion],
      foreignColumns: [t.planId, t.version],
    }),
    check(
      "plan_ancestry",
      sql`(${t.version}=1 AND ${t.parentVersion} IS NULL) OR (${t.version}>1 AND ${t.parentVersion} IS NOT NULL AND ${t.parentVersion}=${t.version}-1)`,
    ),
    check(
      "active_plan_approved",
      sql`${t.state}<>'active' OR (${t.approvedAt} IS NOT NULL AND ${t.deadline}>${t.approvedAt})`,
    ),
  ],
);
export const lessons = pgTable(
  "lessons",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    currentVersion: integer("current_version").notNull().default(1),
  },
  (t) => [unique().on(t.id, t.userId)],
);
export const lessonVersions = pgTable(
  "lesson_versions",
  {
    lessonId: text("lesson_id").notNull(),
    userId: text("user_id").notNull(),
    version: integer("version").notNull(),
    parentVersion: integer("parent_version"),
    rule: text("rule").notNull(),
    scope: jsonb("scope").notNull(),
    approval: text("approval").notNull(),
    status: text("status").notNull(),
    effectiveAt: time("effective_at").notNull(),
    expiresAt: time("expires_at"),
    reviewAt: time("review_at"),
    supersededBy: text("superseded_by"),
    originatingCorrection: text("originating_correction"),
  },
  (t) => [
    primaryKey({ columns: [t.lessonId, t.version] }),
    foreignKey({
      columns: [t.lessonId, t.userId],
      foreignColumns: [lessons.id, lessons.userId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.lessonId, t.parentVersion],
      foreignColumns: [t.lessonId, t.version],
    }),
    check(
      "lesson_ancestry",
      sql`(${t.version}=1 AND ${t.parentVersion} IS NULL) OR (${t.version}>1 AND ${t.parentVersion} IS NOT NULL AND ${t.parentVersion}=${t.version}-1)`,
    ),
    check(
      "lesson_window",
      sql`${t.expiresAt} IS NULL OR ${t.expiresAt}>${t.effectiveAt}`,
    ),
  ],
);
export const observations = pgTable("observations", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  domainEventId: text("domain_event_id").notNull(),
  sourceUrl: text("source_url").notNull(),
  provenance: jsonb("provenance").notNull(),
  excerpt: text("excerpt").notNull(),
  contentHash: text("content_hash").notNull(),
  occurredAt: time("occurred_at"),
  publishedAt: time("published_at"),
  retrievedAt: time("retrieved_at").notNull(),
  freshness: text("freshness").notNull(),
  uncertainty: text("uncertainty").notNull(),
});
export const decisionTraces = pgTable(
  "decision_traces",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pickId: text("pick_id").notNull(),
    pickVersion: integer("pick_version").notNull(),
    planId: text("plan_id"),
    planVersion: integer("plan_version"),
    observationIds: jsonb("observation_ids").notNull(),
    lessonVersions: jsonb("lesson_versions").notNull(),
    decision: jsonb("decision").notNull(),
    citations: jsonb("citations").notNull(),
    modelVersion: text("model_version").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.pickId, t.userId, t.pickVersion],
      foreignColumns: [
        pickVersions.pickId,
        pickVersions.userId,
        pickVersions.version,
      ],
    }).onDelete("cascade"),
  ],
);
export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    nativeId: text("native_id").notNull(),
  },
  (t) => [
    unique().on(t.id, t.userId),
    foreignKey({
      columns: [t.platform, t.nativeId],
      foreignColumns: [markets.platform, markets.nativeId],
    }),
  ],
);
export const turns = pgTable(
  "turns",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    clientRequestId: text("client_request_id").notNull(),
    status: text("status").notNull(),
    text: text("text").notNull(),
    references: jsonb("references").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.userId, t.clientRequestId),
    foreignKey({
      columns: [t.conversationId, t.userId],
      foreignColumns: [conversations.id, conversations.userId],
    }).onDelete("cascade"),
  ],
);
export const changeProposals = pgTable(
  "change_proposals",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    pickId: text("pick_id").notNull(),
    baseVersion: integer("base_version").notNull(),
    changes: jsonb("changes").notNull(),
    reason: text("reason").notNull(),
    evidenceRefs: jsonb("evidence_refs").notNull(),
    expiresAt: time("expires_at").notNull(),
    status: text("status").notNull().default("pending"),
  },
  (t) => [
    foreignKey({
      columns: [t.pickId, t.userId, t.baseVersion],
      foreignColumns: [
        pickVersions.pickId,
        pickVersions.userId,
        pickVersions.version,
      ],
    }).onDelete("cascade"),
  ],
);
export const memoryRecords = pgTable(
  "memory_records",
  {
    logicalId: text("logical_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    schemaVersion: integer("schema_version").notNull(),
    type: text("type").notNull(),
    payloadHash: text("payload_hash").notNull(),
    durableReference: text("durable_reference"),
    receipt: jsonb("receipt"),
    syncStatus: text("sync_status").notNull().default("pending"),
    recordedAt: time("recorded_at").notNull().defaultNow(),
  },
  (t) => [index().on(t.userId, t.syncStatus)],
);
export const outbox = pgTable("outbox", {
  operationKey: text("operation_key").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  state: text("state").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  leaseUntil: time("lease_until"),
  retryAt: time("retry_at"),
  outcome: jsonb("outcome"),
  createdAt: time("created_at").notNull().defaultNow(),
});
export const deliveries = pgTable("deliveries", {
  operationKey: text("operation_key").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  evaluationKey: text("evaluation_key")
    .notNull()
    .references(() => outbox.operationKey),
  channel: text("channel").notNull(),
  state: text("state").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  leaseUntil: time("lease_until"),
  retryAt: time("retry_at"),
  outcome: jsonb("outcome"),
});
export const requests = pgTable(
  "mutation_requests",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    result: jsonb("result").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.requestId] })],
);
export const resolutions = pgTable(
  "resolutions",
  {
    id: text("id").primaryKey(),
    platform: text("platform").notNull(),
    nativeId: text("native_id").notNull(),
    rulesHash: text("rules_hash").notNull(),
    outcome: text("outcome").notNull(),
    officialReference: text("official_reference").notNull(),
    observedAt: time("observed_at").notNull(),
    status: text("status").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.platform, t.nativeId],
      foreignColumns: [markets.platform, markets.nativeId],
    }),
  ],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    requestId: text("request_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    provider: text("provider").notNull(),
    message: text("message").notNull(),
    status: text("status").notNull(),
    result: jsonb("result"),
    createdAt: time("created_at").notNull().defaultNow(),
    finishedAt: time("finished_at"),
  },
  (t) => [
    unique().on(t.userId, t.requestId),
    foreignKey({
      columns: [t.conversationId, t.userId],
      foreignColumns: [conversations.id, conversations.userId],
    }).onDelete("cascade"),
    index("agent_run_history").on(t.conversationId, t.createdAt),
    check(
      "agent_run_status",
      sql`${t.status} IN ('running','completed','failed')`,
    ),
  ],
);

export const marketMonitors = pgTable(
  "market_monitors",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pickId: text("pick_id").notNull(),
    pickVersion: integer("pick_version").notNull(),
    platform: text("platform").notNull(),
    nativeId: text("native_id").notNull(),
    provider: text("provider").notNull(),
    state: text("state").notNull().default("active"),
    deadline: time("deadline").notNull(),
    observation: jsonb("observation"),
    sourceHealth: text("source_health").notNull().default("pending"),
    independentNews: boolean("independent_news").notNull().default(false),
    attempts: integer("attempts").notNull().default(0),
    leaseUntil: time("lease_until"),
    nextCheckAt: time("next_check_at").notNull().defaultNow(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.pickId, t.userId, t.pickVersion],
      foreignColumns: [
        pickVersions.pickId,
        pickVersions.userId,
        pickVersions.version,
      ],
    }).onDelete("cascade"),
    unique().on(t.userId, t.pickId),
    index().on(t.state, t.nextCheckAt),
    check(
      "monitor_state",
      sql`${t.state} IN ('active','paused','expired','superseded')`,
    ),
  ],
);
export const marketUpdates = pgTable("market_updates", {
  id: text("id").primaryKey(),
  monitorId: text("monitor_id")
    .notNull()
    .references(() => marketMonitors.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  dedupeKey: text("dedupe_key").notNull().unique(),
  kind: text("kind").notNull(),
  evidence: jsonb("evidence").notNull(),
  readAt: time("read_at"),
  createdAt: time("created_at").notNull().defaultNow(),
});
export const independentSourceChecks = pgTable(
  "independent_source_checks",
  {
    platform: text("platform").notNull(),
    nativeId: text("native_id").notNull(),
    source: text("source").notNull(),
    value: jsonb("value").notNull(),
    checkedAt: time("checked_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.platform, t.nativeId, t.source] })],
);
export const independentEvidence = pgTable(
  "independent_evidence",
  {
    id: text("id").primaryKey(),
    platform: text("platform").notNull(),
    nativeId: text("native_id").notNull(),
    source: text("source").notNull(),
    item: jsonb("item").notNull(),
    retrievedAt: time("retrieved_at").notNull(),
  },
  (t) => [index().on(t.platform, t.nativeId)],
);
export const independentWatchBaselines = pgTable(
  "independent_watch_baselines",
  {
    monitorId: text("monitor_id")
      .notNull()
      .references(() => marketMonitors.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    pickVersion: integer("pick_version").notNull(),
    value: jsonb("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.monitorId, t.source] })],
);

/** Shared provider reservations are consumed even if a network result is uncertain. */
export const providerCreditBudgets = pgTable(
  "provider_credit_budgets",
  {
    provider: text("provider").notNull(),
    budgetDay: date("budget_day").notNull(),
    credits: integer("credits").notNull(),
    blockedUntil: time("blocked_until"),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.budgetDay] }),
    check("provider_credit_budgets_credits_check", sql`${t.credits} >= 0`),
  ],
);

export const providerPublicCache = pgTable(
  "provider_public_cache",
  {
    provider: text("provider").notNull(),
    queryKey: text("query_key").notNull(),
    payload: jsonb("payload").notNull(),
    expiresAt: time("expires_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.queryKey] }),
    index("provider_public_cache_expiry_idx").on(t.expiresAt),
  ],
);

export const sourceProfiles = pgTable(
  "source_profiles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    sourceName: text("source_name").notNull(),
    kind: text("kind").notNull(),
    cohort: text("cohort").notNull(),
    state: text("state").notNull().default("active"),
    memoryConsent: boolean("memory_consent").notNull(),
    currentVersion: integer("current_version").notNull().default(0),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.id, t.userId),
    unique().on(t.userId, t.sourceId, t.cohort),
    check(
      "source_kind",
      sql`${t.kind} IN ('market_baseline','user_reported_forecaster')`,
    ),
    check("source_state", sql`${t.state} IN ('active','paused')`),
  ],
);
export const sourceForecasts = pgTable(
  "source_forecasts",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id").notNull(),
    userId: text("user_id").notNull(),
    platform: text("platform").notNull(),
    nativeId: text("native_id").notNull(),
    outcome: text("outcome").notNull(),
    probability: jsonb("probability"),
    baselineProbability: jsonb("baseline_probability"),
    scheduledAt: time("scheduled_at"),
    recordedAt: time("recorded_at")
      .notNull()
      .default(sql`clock_timestamp()`),
    reference: text("reference").notNull(),
    rulesHash: text("rules_hash").notNull(),
    revision: integer("revision").notNull().default(1),
    resolution: jsonb("resolution"),
    nextCheckAt: time("next_check_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.profileId, t.userId],
      foreignColumns: [sourceProfiles.id, sourceProfiles.userId],
    }).onDelete("cascade"),
    unique().on(t.profileId, t.platform, t.nativeId),
    index().on(t.platform, t.nativeId),
  ],
);
export const sourceScoreVersions = pgTable(
  "source_score_versions",
  {
    profileId: text("profile_id").notNull(),
    userId: text("user_id").notNull(),
    version: integer("version").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: time("created_at")
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.version] }),
    foreignKey({
      columns: [t.profileId, t.userId],
      foreignColumns: [sourceProfiles.id, sourceProfiles.userId],
    }).onDelete("cascade"),
  ],
);
