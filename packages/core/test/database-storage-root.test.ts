import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { StorageRoot } from "@opencode-ai/core/database/storage-root"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const parentID = "ses_parent"
const childID = "ses_child"
const FIXED_NOW = 1_720_000_000_000

function seedLegacy(filename: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = FIXED_NOW
    yield* db.run(
      sql.raw(`
      INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
      VALUES ('project', '/tmp/project', ${now}, ${now}, '[]')
    `),
    )
    for (const [id, parent, title] of [
      [parentID, null, "Parent"],
      [childID, parentID, "Child"],
    ] as const) {
      yield* db.run(sql`
        INSERT INTO session
          (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
        VALUES
          (${id}, 'project', ${parent}, ${id}, '/tmp/project', ${title}, 'test', ${now}, ${now})
      `)
    }
    yield* db.run(sql`
      INSERT INTO task_run
        (id, parent_session_id, description, subagent_type, mode, status, time_created, time_updated)
      VALUES
        (${childID}, ${parentID}, 'legacy task', 'general', 'sync', 'running', ${now}, ${now})
    `)
  }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped)
}

function seedTaskOnly(filename: string) {
  // Write a raw task-only SQLite file without going through Database.layerFromPath,
  // which would immediately prepare/wipe a task-only target.
  return Effect.promise(async () => {
    const { Database: BunDatabase } = await import("bun:sqlite")
    const db = new BunDatabase(filename)
    db.run(`
      CREATE TABLE task_run (
        id text PRIMARY KEY,
        parent_session_id text NOT NULL,
        description text NOT NULL,
        subagent_type text NOT NULL,
        mode text NOT NULL,
        status text NOT NULL,
        started_at integer,
        finished_at integer,
        result_summary text,
        last_error text,
        time_created integer NOT NULL,
        time_updated integer NOT NULL
      )
    `)
    db.run(
      `INSERT INTO task_run
        (id, parent_session_id, description, subagent_type, mode, status, time_created, time_updated)
       VALUES (?, ?, 'legacy task', 'general', 'sync', 'running', ?, ?)`,
      [childID, parentID, FIXED_NOW, FIXED_NOW],
    )
    db.close()
  })
}

function seedProject(filename: string, now: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(
      sql.raw(`
        INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
        VALUES ('project', '/tmp/project', ${now}, ${now}, '[]')
      `),
    )
  }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped)
}

describe("Finny storage root", () => {
  it.live("serializes concurrent reconciliation for one storage root", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const data = path.join(tmp.path, "data")
          const source = path.join(data, "opencode", "opencode-local.db")
          const target = path.join(data, "finny", "opencode-local.db")
          yield* Effect.promise(() => fs.mkdir(path.dirname(source), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.dirname(target), { recursive: true }))
          yield* seedProject(target, FIXED_NOW)
          yield* seedProject(source, FIXED_NOW + 10_000)
          yield* Effect.promise(() => fs.writeFile(`${source}.pre-unify-opencode.bak`, "previous source snapshot"))
          yield* Effect.promise(() => fs.writeFile(`${target}.pre-unify-finny.bak`, "previous target snapshot"))

          const loadMigration = () =>
            Effect.gen(function* () {
              const { db } = yield* Database.Service
              return yield* db.get<{ id: string }>(sql`
                SELECT id FROM storage_root_migration WHERE id = ${StorageRoot.migrationID}
              `)
            }).pipe(Effect.provide(Database.layerFromPath(target)), Effect.scoped)

          const migrations = yield* Effect.all([loadMigration(), loadMigration()], { concurrency: "unbounded" })
          expect(migrations).toEqual([{ id: StorageRoot.migrationID }, { id: StorageRoot.migrationID }])
        }),
      ),
    ),
  )

  it.live("serializes task-only backup preparation across concurrent startups", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const data = path.join(tmp.path, "data")
          const source = path.join(data, "opencode", "opencode-local.db")
          const target = path.join(data, "finny", "opencode-local.db")
          yield* Effect.promise(() => fs.mkdir(path.dirname(source), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.dirname(target), { recursive: true }))
          yield* seedLegacy(source)
          yield* seedTaskOnly(target)

          const loadJoinedTaskCount = () =>
            Effect.gen(function* () {
              const { db } = yield* Database.Service
              return yield* db.get<{ count: number }>(
                sql.raw(`
                SELECT COUNT(*) AS count
                FROM task_run task
                JOIN session child ON child.id = task.id
                JOIN session parent ON parent.id = task.parent_session_id
              `),
              )
            }).pipe(Effect.provide(Database.layerFromPath(target)), Effect.scoped)

          const results = yield* Effect.all([loadJoinedTaskCount(), loadJoinedTaskCount()], {
            concurrency: "unbounded",
          })
          expect(results).toEqual([{ count: 1 }, { count: 1 }])
          expect(yield* Effect.promise(() => Bun.file(`${target}.pre-unify-task-only.bak`).exists())).toBe(true)
        }),
      ),
    ),
  )

  it.live("merges benign timestamp drift for the same project identity", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const data = path.join(tmp.path, "data")
          const source = path.join(data, "opencode", "opencode-local.db")
          const target = path.join(data, "finny", "opencode-local.db")
          yield* Effect.promise(() => fs.mkdir(path.dirname(source), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.dirname(target), { recursive: true }))

          // Seed the target before the sibling source exists so its initial
          // database boot cannot reconcile early.
          yield* seedProject(target, FIXED_NOW)
          yield* seedProject(source, FIXED_NOW + 10_000)
          const originalSourceBackup = `${source}.pre-unify-opencode.bak`
          const originalTargetBackup = `${target}.pre-unify-finny.bak`
          yield* Effect.promise(() => fs.writeFile(originalSourceBackup, "previous source snapshot"))
          yield* Effect.promise(() => fs.writeFile(originalTargetBackup, "previous target snapshot"))

          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            expect(
              yield* db.get<{ timeCreated: number; timeUpdated: number }>(
                sql.raw(
                  `SELECT time_created AS timeCreated, time_updated AS timeUpdated FROM project WHERE id = 'project'`,
                ),
              ),
            ).toEqual({ timeCreated: FIXED_NOW, timeUpdated: FIXED_NOW + 10_000 })
            const migration = yield* db.get<{ sourceBackup: string; targetBackup: string }>(sql`
              SELECT source_backup AS sourceBackup, target_backup AS targetBackup
              FROM storage_root_migration
              WHERE id = ${StorageRoot.migrationID}
            `)
            expect(migration?.sourceBackup).toStartWith(`${originalSourceBackup}.retry-`)
            expect(migration?.targetBackup).toStartWith(`${originalTargetBackup}.retry-`)
            expect(yield* Effect.promise(() => Bun.file(migration!.sourceBackup).exists())).toBe(true)
            expect(yield* Effect.promise(() => Bun.file(migration!.targetBackup).exists())).toBe(true)
          }).pipe(Effect.provide(Database.layerFromPath(target)), Effect.scoped)

          expect(yield* Effect.promise(() => fs.readFile(originalSourceBackup, "utf8"))).toBe(
            "previous source snapshot",
          )
          expect(yield* Effect.promise(() => fs.readFile(originalTargetBackup, "utf8"))).toBe(
            "previous target snapshot",
          )
        }),
      ),
    ),
  )

  it.live("bootstraps past a task-only Finny-root DB and merges after session reconcile", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const data = path.join(tmp.path, "data")
          const source = path.join(data, "opencode", "opencode-local.db")
          const target = path.join(data, "finny", "opencode-local.db")
          yield* Effect.promise(() => fs.mkdir(path.dirname(source), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.dirname(target), { recursive: true }))
          // Sessions live in the legacy opencode root; tasks already occupy the Finny path.
          yield* seedLegacy(source)
          yield* seedTaskOnly(target)

          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            expect(yield* db.get<{ found: number }>(sql.raw(`SELECT 1 AS found FROM session LIMIT 1`))).toBeDefined()
            // The orphaned task cannot join sessions from the task-only backup alone unless
            // the same parent/child ids were also present in the opencode source — seedLegacy
            // uses the same ids, so the merge keeps the joinable task row.
            const joined = yield* db.all<{ child: string }>(
              sql.raw(`
              SELECT child.id AS child
              FROM task_run task
              JOIN session child ON child.id = task.id
            `),
            )
            expect(joined.length).toBeGreaterThanOrEqual(1)
          }).pipe(Effect.provide(Database.layerFromPath(target)), Effect.scoped)

          expect(yield* Effect.promise(() => Bun.file(`${target}.pre-unify-task-only.bak`).exists())).toBe(true)
        }),
      ),
    ),
  )

  it.live("migrates a legacy opencode trajectory once and keeps it joinable", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const data = path.join(tmp.path, "data")
          const source = path.join(data, "opencode", "opencode-local.db")
          const target = path.join(data, "finny", "opencode-local.db")
          yield* Effect.promise(() => fs.mkdir(path.dirname(source), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.dirname(target), { recursive: true }))
          yield* seedLegacy(source)

          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            const joined = yield* db.all<{ parent: string; child: string; status: string }>(
              sql.raw(`
              SELECT parent.id AS parent, child.id AS child, task.status AS status
              FROM task_run task
              JOIN session parent ON parent.id = task.parent_session_id
              JOIN session child ON child.id = task.id
            `),
            )
            expect(joined).toEqual([{ parent: parentID, child: childID, status: "running" }])
            expect(
              yield* db.get(sql`SELECT id FROM storage_root_migration WHERE id = ${StorageRoot.migrationID}`),
            ).toBeDefined()
          }).pipe(Effect.provide(Database.layerFromPath(target)), Effect.scoped)

          expect(yield* Effect.promise(() => Bun.file(`${source}.pre-unify-opencode.bak`).exists())).toBe(true)
          expect(yield* Effect.promise(() => Bun.file(`${target}.pre-unify-finny.bak`).exists())).toBe(true)

          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            expect((yield* db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM task_run`))?.count).toBe(1)
          }).pipe(Effect.provide(Database.layerFromPath(target)), Effect.scoped)
        }),
      ),
    ),
  )
})
