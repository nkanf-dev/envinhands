import { Database } from "bun:sqlite";
import { parseRegistration, parseChange, type AgentRegistration, type ChangeRecord, type ChangePage } from "./change-model.ts";

export class ChangeStoreError extends Error {
  constructor(readonly status: 404 | 409, message: string) { super(message); }
}
/** Append-only through this API. Shared-token holders and DB owners are trusted. */
export function createChangeStore(dbPath: string) {
  if (typeof dbPath !== "string" || !dbPath) throw new Error("A database path is required");
  const db = new Database(dbPath, { create: true, strict: true });
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS agent_registrations (
        registration_id TEXT PRIMARY KEY, payload TEXT NOT NULL, registered_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS change_records (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE,
        registration_id TEXT NOT NULL REFERENCES agent_registrations(registration_id),
        payload TEXT NOT NULL, recorded_at TEXT NOT NULL
      );`);
  } catch (error) { db.close(); throw error; }
  type RegistrationRow = { payload: string; registered_at: string };
  type RecordRow = { sequence: number; payload: string; recorded_at: string; registration_payload: string; registered_at: string };
  const findRegistration = db.query<RegistrationRow, [string]>(
    "SELECT payload, registered_at FROM agent_registrations WHERE registration_id = ?");
  const selectRecord = `SELECT c.sequence, c.payload, c.recorded_at, r.payload AS registration_payload, r.registered_at
    FROM change_records c JOIN agent_registrations r ON r.registration_id = c.registration_id`;
  const findRecord = db.query<RecordRow, [string]>(`${selectRecord} WHERE c.request_id = ?`);
  const registration = (row: RegistrationRow): AgentRegistration => ({ ...JSON.parse(row.payload), registeredAt: row.registered_at });
  const record = (row: RecordRow): ChangeRecord => ({ ...JSON.parse(row.payload), sequence: row.sequence,
    recordedAt: row.recorded_at, registration: registration({ payload: row.registration_payload, registered_at: row.registered_at }) });
  const register = db.transaction((input: unknown) => {
    const value = parseRegistration(input), payload = JSON.stringify(value);
    const inserted = db.query("INSERT OR IGNORE INTO agent_registrations VALUES (?, ?, ?)")
      .run(value.registrationId, payload, new Date().toISOString()).changes;
    const row = findRegistration.get(value.registrationId)!;
    if (row.payload !== payload) throw new ChangeStoreError(409, "Registration ID conflict");
    return { registration: registration(row), duplicate: inserted === 0 };
  });
  const append = db.transaction((input: unknown) => {
    const value = parseChange(input), payload = JSON.stringify(value);
    const previous = findRecord.get(value.requestId);
    if (previous) {
      if (previous.payload !== payload) throw new ChangeStoreError(409, "Request ID conflict");
      return { record: record(previous), duplicate: true };
    }
    if (!findRegistration.get(value.registrationId)) throw new ChangeStoreError(404, "Registration not found");
    const inserted = db.query("INSERT OR IGNORE INTO change_records (request_id, registration_id, payload, recorded_at) VALUES (?, ?, ?, ?)")
      .run(value.requestId, value.registrationId, payload, new Date().toISOString()).changes;
    const row = findRecord.get(value.requestId)!;
    if (row.payload !== payload) throw new ChangeStoreError(409, "Request ID conflict");
    return { record: record(row), duplicate: inserted === 0 };
  });
  let closed = false;
  return {
    register,
    append,
    list(after: number, limit: number): ChangePage {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("Invalid page");
      const rows = db.query<RecordRow, [number, number]>(`${selectRecord} WHERE c.sequence > ? ORDER BY c.sequence LIMIT ?`).all(after, limit + 1);
      const records = rows.slice(0, limit).map(record);
      return { records, nextAfter: rows.length > limit ? records[records.length - 1].sequence : null };
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}
