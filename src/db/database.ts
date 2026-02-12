import Database from "better-sqlite3";
import path from "path";
import { getConfig } from "../config.js";
import { SCHEMA_SQL, MIGRATIONS, getSeedSQL } from "./schema.js";

let db: Database.Database | null = null;

function runMigrations(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  for (const migration of MIGRATIONS) {
    const applied = database
      .prepare("SELECT 1 FROM _migrations WHERE name = ?")
      .get(migration.name);
    if (!applied) {
      console.log(`  Running migration: ${migration.name}`);
      database.exec(migration.sql);
      database
        .prepare("INSERT INTO _migrations (name) VALUES (?)")
        .run(migration.name);
    }
  }
}

export function getDb(): Database.Database {
  if (db) return db;

  const config = getConfig();
  const dbPath = path.resolve(config.dbPath);
  db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(SCHEMA_SQL);
  runMigrations(db);
  db.exec(getSeedSQL());

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
