import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), "data", "app.db");
const SCHEMA_PATH = path.join(process.cwd(), "app/lib/db/schema.sql");

// schema.sql is all CREATE TABLE IF NOT EXISTS, so it never alters a table that
// already exists. Columns added to an existing table therefore need an explicit
// ALTER here as well. Each statement is idempotent: re-running it on a database
// that already has the column raises "duplicate column name", which we swallow.
const MIGRATIONS = [
  "ALTER TABLE org_bookings ADD COLUMN booked_by_agent_id TEXT",
  "ALTER TABLE org_bookings ADD COLUMN booked_by_agent_name TEXT",
];

function runMigrations(db: Database.Database) {
  for (const statement of MIGRATIONS) {
    try {
      db.exec(statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column name/i.test(message)) throw error;
    }
  }
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.exec(fs.readFileSync(SCHEMA_PATH, "utf-8"));
  runMigrations(_db);

  return _db;
}
