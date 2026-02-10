import Database from "better-sqlite3";
import path from "path";
import { getConfig } from "../config.js";
import { SCHEMA_SQL, getSeedSQL } from "./schema.js";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const config = getConfig();
  const dbPath = path.resolve(config.dbPath);
  db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(SCHEMA_SQL);
  db.exec(getSeedSQL());

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
