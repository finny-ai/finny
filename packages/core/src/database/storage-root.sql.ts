import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const StorageRootMigrationTable = sqliteTable("storage_root_migration", {
  id: text().primaryKey(),
  source_path: text().notNull(),
  target_path: text().notNull(),
  source_backup: text().notNull(),
  target_backup: text().notNull(),
  time_completed: integer().notNull(),
})
