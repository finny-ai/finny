import fs from "fs/promises"
import nodePath from "path"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Flag } from "../flag/flag"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Column = { name: string; notnull: number; dflt_value: unknown; pk: number }
type MergePlan = { name: string; shared: Column[]; join: string }
type MigrationPaths = {
  source: string
  target: string
  sourceBackup: string
  targetBackup: string
}

export const migrationID = "finny-unified-storage-root-v1"

const tables = [
  "account",
  "account_state",
  "control_account",
  "credential",
  "project",
  "project_directory",
  "workspace",
  "data_migration",
  "session",
  "event_sequence",
  "event",
  "message",
  "session_message",
  "session_input",
  "session_context_epoch",
  "part",
  "todo",
  "permission",
  "session_share",
  "task_run",
  "watcher_state",
] as const

function identifier(value: string) {
  return `\"${value.replaceAll('"', '""')}\"`
}

function literal(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function legacyPath(target: string) {
  return nodePath.join(nodePath.dirname(nodePath.dirname(target)), "opencode", nodePath.basename(target))
}

function backupPath(input: { database: string; owner: "finny" | "opencode" }) {
  return `${input.database}.pre-unify-${input.owner}.bak`
}

function tableExists(db: Database, input: { schema: "main" | "legacy"; table: string }) {
  return db.get<{ found: number }>(
    sql.raw(
      `SELECT 1 AS found FROM ${input.schema}.sqlite_master WHERE type = 'table' AND name = ${literal(input.table)}`,
    ),
  )
}

function columns(db: Database, input: { schema: "main" | "legacy"; table: string }) {
  return db.all<Column>(sql.raw(`PRAGMA ${input.schema}.table_info(${literal(input.table)})`))
}

function fileExists(path: string) {
  return Effect.promise(() =>
    fs
      .stat(path)
      .then(() => true)
      .catch(() => false),
  )
}

function migrationCompleted(db: Database) {
  return db.get<{ id: string }>(sql`SELECT id FROM storage_root_migration WHERE id = ${migrationID}`)
}

function isDefaultFinnyTarget(target: string) {
  return !Flag.OPENCODE_DB && target !== ":memory:" && nodePath.basename(nodePath.dirname(target)) === "finny"
}

function migrationPaths(target: string): MigrationPaths | undefined {
  if (!isDefaultFinnyTarget(target)) return
  const source = legacyPath(target)
  if (source === target) return
  return {
    source,
    target,
    sourceBackup: backupPath({ database: source, owner: "opencode" }),
    targetBackup: backupPath({ database: target, owner: "finny" }),
  }
}

function requireCompatibleColumns(input: { table: string; target: Column[]; source: Column[] }) {
  const sourceNames = new Set(input.source.map((column) => column.name))
  const missing = input.target.filter(
    (column) => !sourceNames.has(column.name) && column.notnull === 1 && column.dflt_value === null,
  )
  if (missing.length === 0) return Effect.void
  return Effect.die(
    `Cannot migrate legacy ${input.table}: source is missing required columns ${missing.map((item) => item.name).join(", ")}`,
  )
}

function buildMergePlan(input: { table: string; target: Column[]; source: Column[] }): MergePlan | undefined {
  const sourceNames = new Set(input.source.map((column) => column.name))
  const shared = input.target.filter((column) => sourceNames.has(column.name))
  const primary = input.target.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk)
  if (primary.length === 0 || shared.length === 0) return
  return {
    name: identifier(input.table),
    shared,
    join: primary
      .map((column) => `target.${identifier(column.name)} IS source.${identifier(column.name)}`)
      .join(" AND "),
  }
}

function collisionCount(db: Database, plan: MergePlan) {
  // Project ids are derived from their worktree. Independent Finny/opencode
  // processes routinely touch the same project row at different times, so the
  // timestamps are replication metadata rather than a meaningful divergence.
  // Every other shared field (including worktree and sandboxes) must still
  // match exactly or migration stops with both backups retained.
  const compared =
    plan.name === identifier("project")
      ? plan.shared.filter((column) => !["time_created", "time_updated"].includes(column.name))
      : plan.shared
  if (compared.length === 0) return Effect.succeed({ count: 0 })
  const differs = compared
    .map((column) => `target.${identifier(column.name)} IS NOT source.${identifier(column.name)}`)
    .join(" OR ")
  return db.get<{ count: number }>(
    sql.raw(
      `SELECT COUNT(*) AS count FROM main.${plan.name} target JOIN legacy.${plan.name} source ON ${plan.join} WHERE ${differs}`,
    ),
  )
}

function mergeProjectTimestamps(db: Database, plan: MergePlan) {
  if (plan.name !== identifier("project")) return Effect.void
  const names = new Set(plan.shared.map((column) => column.name))
  if (!names.has("time_created") || !names.has("time_updated")) return Effect.void
  return db.run(
    sql.raw(`
      UPDATE main.${plan.name} AS target
      SET time_created = MIN(target.time_created, source.time_created),
          time_updated = MAX(target.time_updated, source.time_updated)
      FROM legacy.${plan.name} AS source
      WHERE ${plan.join}
    `),
  )
}

function requireNoCollisions(input: { table: string; count: number }) {
  if (input.count === 0) return Effect.void
  return Effect.die(
    `Mixed Finny/opencode storage roots contain ${input.count} divergent ${input.table} record(s); backups were retained and startup was stopped`,
  )
}

function insertMissingRows(db: Database, plan: MergePlan) {
  const names = plan.shared.map((column) => identifier(column.name)).join(", ")
  const selection = plan.shared.map((column) => `source.${identifier(column.name)}`).join(", ")
  return db.run(
    sql.raw(
      `INSERT INTO main.${plan.name} (${names}) SELECT ${selection} FROM legacy.${plan.name} source WHERE NOT EXISTS (SELECT 1 FROM main.${plan.name} target WHERE ${plan.join})`,
    ),
  )
}

function loadMergePlan(db: Database, table: string) {
  return Effect.gen(function* () {
    if (!(yield* tableExists(db, { schema: "main", table })) || !(yield* tableExists(db, { schema: "legacy", table })))
      return
    const target = yield* columns(db, { schema: "main", table })
    const source = yield* columns(db, { schema: "legacy", table })
    yield* requireCompatibleColumns({ table, target, source })
    return buildMergePlan({ table, target, source })
  })
}

function mergeTable(db: Database, table: string) {
  return Effect.gen(function* () {
    const plan = yield* loadMergePlan(db, table)
    if (!plan) return
    const collision = yield* collisionCount(db, plan)
    yield* requireNoCollisions({ table, count: collision?.count ?? 0 })
    yield* mergeProjectTimestamps(db, plan)
    yield* insertMissingRows(db, plan)
  })
}

function ensureBackup(db: Database, input: { schema: "main" | "legacy"; path: string }) {
  return Effect.gen(function* () {
    const path = (yield* fileExists(input.path)) ? `${input.path}.retry-${Date.now()}` : input.path
    yield* db.run(sql.raw(`VACUUM ${input.schema} INTO ${literal(path)}`))
    return path
  })
}

function requireTaskLinks(db: Database) {
  return Effect.gen(function* () {
    const orphan = yield* db.get<{ count: number }>(
      sql.raw(`
        SELECT COUNT(*) AS count
        FROM task_run task
        LEFT JOIN session child ON child.id = task.id
        LEFT JOIN session parent ON parent.id = task.parent_session_id
        WHERE child.id IS NULL OR parent.id IS NULL
      `),
    )
    if ((orphan?.count ?? 0) === 0) return
    return yield* Effect.die(
      `Unified storage contains ${orphan!.count} task_run record(s) without both parent and child sessions`,
    )
  })
}

function recordMigration(db: Database, paths: MigrationPaths) {
  return db.run(sql`
    INSERT INTO storage_root_migration
      (id, source_path, target_path, source_backup, target_backup, time_completed)
    VALUES
      (${migrationID}, ${paths.source}, ${paths.target}, ${paths.sourceBackup}, ${paths.targetBackup}, ${Date.now()})
  `)
}

function mergeAttachedDatabase(db: Database, paths: MigrationPaths) {
  return Effect.gen(function* () {
    // A previous failed attempt may have already created the canonical backup
    // names. Preserve those snapshots and take fresh retry backups so the
    // migration record always points at the exact databases being merged now.
    const sourceBackup = yield* ensureBackup(db, { schema: "legacy", path: paths.sourceBackup })
    const targetBackup = yield* ensureBackup(db, { schema: "main", path: paths.targetBackup })
    const attempt = { ...paths, sourceBackup, targetBackup }
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.run("PRAGMA defer_foreign_keys = ON")
        for (const table of tables) yield* mergeTable(tx, table)
        yield* requireTaskLinks(tx)
        yield* recordMigration(tx, attempt)
      }),
    )
  })
}

function withLegacyDatabase(db: Database, paths: MigrationPaths) {
  return db
    .run(sql.raw(`ATTACH DATABASE ${literal(paths.source)} AS legacy`))
    .pipe(
      Effect.andThen(mergeAttachedDatabase(db, paths)),
      Effect.ensuring(db.run(sql.raw("DETACH DATABASE legacy")).pipe(Effect.orDie)),
    )
}

function userTables(db: Database) {
  return db.all<{ name: string }>(
    sql.raw(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`),
  )
}

function isLegacyTaskOnly(tables: { name: string }[]) {
  if (tables.some((table) => table.name === "session")) return false
  if (tables.length === 0) return false
  const names = new Set(tables.map((table) => table.name))
  // Pre-unification Finny-root opencode DB: task registry without session graph.
  return names.has("task_run") || names.has("watcher_state")
}

function wipeUserTables(db: Database) {
  return Effect.gen(function* () {
    yield* db.run("PRAGMA foreign_keys = OFF")
    const tables = yield* userTables(db)
    for (const table of tables) {
      yield* db.run(sql.raw(`DROP TABLE IF EXISTS ${identifier(table.name)}`))
    }
    yield* db.run("PRAGMA foreign_keys = ON")
  })
}

/**
 * Before core migrations run: if the Finny-root target is a leftover task-only
 * opencode DB (task_run/watcher_state, no session), VACUUM it aside and wipe so
 * DatabaseMigration.apply can bootstrap the unified schema. The backup is merged
 * after apply via reconcileTaskOnlyBackup.
 */
export function prepareTarget(db: Database, target: string) {
  return Effect.gen(function* () {
    if (target === ":memory:") return
    const tables = yield* userTables(db)
    if (tables.some((table) => table.name === "session") || tables.length === 0) return
    if (!isLegacyTaskOnly(tables)) {
      return yield* Effect.die("Database is not empty and has no session table")
    }
    const backup = `${target}.pre-unify-task-only.bak`
    if (!(yield* fileExists(backup))) {
      yield* db.run(sql.raw(`VACUUM INTO ${literal(backup)}`))
    }
    yield* wipeUserTables(db)
  })
}

function taskLegacyTableExists(db: Database, table: string) {
  return db.get<{ found: number }>(
    sql.raw(
      `SELECT 1 AS found FROM task_legacy.sqlite_master WHERE type = 'table' AND name = ${literal(table)}`,
    ),
  )
}

function mergeOneTaskLegacyTable(db: Database, table: "task_run" | "watcher_state") {
  return Effect.gen(function* () {
    if (!(yield* tableExists(db, { schema: "main", table }))) return
    if (!(yield* taskLegacyTableExists(db, table))) return
    const targetCols = yield* columns(db, { schema: "main", table })
    const sourceCols = yield* db.all<Column>(sql.raw(`PRAGMA task_legacy.table_info(${literal(table)})`))
    yield* requireCompatibleColumns({ table, target: targetCols, source: sourceCols })
    const plan = buildMergePlan({ table, target: targetCols, source: sourceCols })
    if (!plan) return
    const names = plan.shared.map((column) => identifier(column.name)).join(", ")
    const selection = plan.shared.map((column) => `source.${identifier(column.name)}`).join(", ")
    const primary = targetCols.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk)
    const join = primary
      .map((column) => `target.${identifier(column.name)} IS source.${identifier(column.name)}`)
      .join(" AND ")
    const differs = plan.shared
      .map((column) => `target.${identifier(column.name)} IS NOT source.${identifier(column.name)}`)
      .join(" OR ")
    const collision = yield* db.get<{ count: number }>(
      sql.raw(
        `SELECT COUNT(*) AS count FROM main.${plan.name} target JOIN task_legacy.${plan.name} source ON ${join} WHERE ${differs}`,
      ),
    )
    yield* requireNoCollisions({ table, count: collision?.count ?? 0 })
    yield* db.run(
      sql.raw(
        `INSERT INTO main.${plan.name} (${names}) SELECT ${selection} FROM task_legacy.${plan.name} source WHERE NOT EXISTS (SELECT 1 FROM main.${plan.name} target WHERE ${join})`,
      ),
    )
  })
}

function mergeTaskOnlyBackup(db: Database, target: string) {
  return Effect.gen(function* () {
    const backup = `${target}.pre-unify-task-only.bak`
    if (!(yield* fileExists(backup))) return
    // Merge task_run/watcher_state from the pre-schema task-only Finny DB after
    // sessions were reconciled from the opencode sibling root.
    yield* db.run(sql.raw(`ATTACH DATABASE ${literal(backup)} AS task_legacy`)).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          yield* mergeOneTaskLegacyTable(db, "task_run")
          yield* mergeOneTaskLegacyTable(db, "watcher_state")
          if (yield* tableExists(db, { schema: "main", table: "task_run" })) {
            // Drop rows that cannot satisfy session FKs after the unified schema.
            yield* db.run(sql.raw(`
              DELETE FROM task_run
              WHERE id NOT IN (SELECT id FROM session)
                 OR parent_session_id NOT IN (SELECT id FROM session)
            `))
          }
        }),
      ),
      Effect.ensuring(db.run(sql.raw("DETACH DATABASE task_legacy")).pipe(Effect.orDie)),
    )
  })
}

function reconcileLegacySource(db: Database, paths: MigrationPaths | undefined) {
  return Effect.gen(function* () {
    if (!paths) return
    if (yield* migrationCompleted(db)) return
    if (!(yield* fileExists(paths.source))) return
    yield* withLegacyDatabase(db, paths)
  })
}

export function reconcile(db: Database, target: string) {
  return Effect.gen(function* () {
    yield* reconcileLegacySource(db, migrationPaths(target))
    yield* mergeTaskOnlyBackup(db, target)
  })
}

export * as StorageRoot from "./storage-root"
