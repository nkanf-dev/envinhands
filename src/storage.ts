/** Standalone SQLite storage. This is not connected to the control handler. */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Machine, ResourceMessage } from "./control.ts";

/** Readiness is a point-in-time check using the server's configured SSH identity. */
export interface StoredMachine extends Machine {
  sshUser: string | null;
  relayNodeId: string | null;
  status: "pending" | "ready" | "not-ready";
  verifiedAt: string | null;
  checkedAt: string | null;
}
const DEFAULT_READINESS_TTL_MS = 5 * 60_000;

export interface RegisterMachine {
  id: string;
  name: string;
  host: string;
  os: string;
  sshPort?: number;
  sshUser: string;
  relayNodeId?: string;
}

const ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`Invalid ${field}`);
  return value;
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new Error(`Invalid ${field}`);
  }
  return value.trim();
}

/** Open explicitly with Storage.open(path); close when finished. */
export class Storage {
  private closed = false;
  private constructor(private readonly db: Database, private readonly readinessTtlMs: number) {}

  static open(path: string, readinessTtlMs = DEFAULT_READINESS_TTL_MS): Storage {
    if (typeof path !== "string" || path.length === 0) throw new Error("Invalid database path");
    if (!Number.isFinite(readinessTtlMs) || readinessTtlMs <= 0) throw new Error("Invalid readiness TTL");
    const db = new Database(path, { create: true, strict: true });
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS machines (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          host TEXT NOT NULL,
          os TEXT NOT NULL,
          sshPort INTEGER NOT NULL CHECK (sshPort BETWEEN 1 AND 65535),
          registeredAt TEXT NOT NULL,
          lastHeartbeatAt TEXT
        );
        CREATE TABLE IF NOT EXISTS resource_messages (
          id TEXT PRIMARY KEY NOT NULL,
          resourceId TEXT NOT NULL,
          author TEXT NOT NULL,
          text TEXT NOT NULL,
          createdAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS resource_messages_resource_id ON resource_messages(resourceId);
      `);
      // Lock the schema while checking and adding columns, so concurrent openers
      // cannot both try to add the same column. Old records are not trusted.
      db.exec("BEGIN IMMEDIATE");
      try {
        const columns = new Set(db.query<{name: string}, []>("PRAGMA table_info(machines)").all().map(c => c.name));
        for (const [name, definition] of [
          ["sshUser", "TEXT"], ["status", "TEXT NOT NULL DEFAULT 'not-ready'"],
          ["verifiedAt", "TEXT"], ["checkedAt", "TEXT"], ["verificationToken", "TEXT"],
          ["relayNodeId", "TEXT"],
        ]) {
          if (!columns.has(name)) db.exec(`ALTER TABLE machines ADD COLUMN ${name} ${definition}`);
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return new Storage(db, readinessTtlMs);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  private checkOpen(): void {
    if (this.closed) throw new Error("Storage is closed");
  }

  private machine(row: (StoredMachine & { verificationToken?: string | null }) | null): StoredMachine | null {
    if (!row) return null;
    const { verificationToken: _token, ...machine } = row;
    const verified = machine.verifiedAt === null ? NaN : Date.parse(machine.verifiedAt);
    if (machine.status === "ready" && (!machine.sshUser || !Number.isFinite(verified) || verified > Date.now() || Date.now() - verified >= this.readinessTtlMs)) {
      machine.status = "not-ready";
    }
    return machine;
  }

  registerMachine(input: RegisterMachine): StoredMachine {
    this.checkOpen();
    if (input === null || typeof input !== "object") throw new Error("Invalid machine");
    const id = identifier(input.id, "id");
    const name = text(input.name, "name", 200);
    const host = text(input.host, "host", 253);
    const os = text(input.os, "os", 100);
    const sshUser = text(input.sshUser, "sshUser", 64);
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(sshUser)) throw new Error("Invalid sshUser");
    const sshPort = input.sshPort === undefined ? 22 : input.sshPort;
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) throw new Error("Invalid sshPort");
    const relayNodeId = input.relayNodeId === undefined ? null : identifier(input.relayNodeId, "relayNodeId");
    const registeredAt = new Date().toISOString();
    this.db.query(`INSERT INTO machines (id, name, host, os, sshPort, sshUser, relayNodeId, registeredAt, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(id, name, host, os, sshPort, sshUser, relayNodeId, registeredAt);
    return this.getMachine(id)!;
  }

  getMachine(id: string): StoredMachine | null {
    this.checkOpen();
    return this.machine(this.db.query<StoredMachine, [string]>("SELECT * FROM machines WHERE id = ?").get(identifier(id, "id")));
  }

  /** Low-level catalog listing. API applies visibility rules after expiry. */
  listMachines(os?: string): StoredMachine[] {
    this.checkOpen();
    const rows = os === undefined ? this.db.query<StoredMachine, []>("SELECT * FROM machines ORDER BY rowid").all()
      : this.db.query<StoredMachine, [string]>("SELECT * FROM machines WHERE os = ? ORDER BY rowid").all(text(os, "os", 100));
    return rows.map(row => this.machine(row)!);
  }

  /**
   * Replace the verification token so stale concurrent results cannot win.
   * Manual checks invalidate evidence immediately by default. Background checks
   * may retain existing ready evidence, but never change its timestamp: normal
   * TTL expiry still applies even if the check or process never finishes.
   */
  beginVerification(id: string, options?: { preserveReady?: boolean }): string {
    this.checkOpen();
    const token = randomUUID();
    const result = options?.preserveReady === true
      ? this.db.query(`UPDATE machines SET
          status = CASE WHEN status = 'ready' THEN status ELSE 'not-ready' END,
          verifiedAt = CASE WHEN status = 'ready' THEN verifiedAt ELSE NULL END,
          verificationToken = ? WHERE id = ?`).run(token, identifier(id, "id"))
      : this.db.query("UPDATE machines SET status = 'not-ready', verifiedAt = NULL, verificationToken = ? WHERE id = ?").run(token, identifier(id, "id"));
    if (!result.changes) throw new Error("Machine not found");
    return token;
  }

  recordVerification(id: string, ready: boolean, token?: string): StoredMachine {
    this.checkOpen();
    const now = new Date().toISOString();
    if (token === undefined) {
      this.db.query("UPDATE machines SET status = ?, verifiedAt = ?, checkedAt = ?, verificationToken = NULL WHERE id = ?")
        .run(ready ? "ready" : "not-ready", ready ? now : null, now, identifier(id, "id"));
    } else {
      this.db.query("UPDATE machines SET status = ?, verifiedAt = ?, checkedAt = ?, verificationToken = NULL WHERE id = ? AND verificationToken = ?")
        .run(ready ? "ready" : "not-ready", ready ? now : null, now, identifier(id, "id"), token);
    }
    const machine = this.getMachine(id);
    if (!machine) throw new Error("Machine not found");
    return machine;
  }

  /** Records receipt time only; it does not check availability or renew readiness. */
  recordHeartbeat(id: string): StoredMachine {
    this.checkOpen();
    const row = this.db.query<StoredMachine, [string, string]>(
      "UPDATE machines SET lastHeartbeatAt = ? WHERE id = ? RETURNING *",
    ).get(new Date().toISOString(), identifier(id, "id"));
    if (!row) throw new Error("Machine not found");
    return this.machine(row)!;
  }

  addMessage(resourceId: string, author: string, message: string): ResourceMessage {
    this.checkOpen();
    const item: ResourceMessage = {
      id: randomUUID(), resourceId: identifier(resourceId, "resource id"),
      author: text(author, "author", 200), text: text(message, "text", 4000),
      createdAt: new Date().toISOString(),
    };
    this.db.query("INSERT INTO resource_messages (id, resourceId, author, text, createdAt) VALUES (?, ?, ?, ?, ?)")
      .run(item.id, item.resourceId, item.author, item.text, item.createdAt);
    return item;
  }

  listMessages(resourceId: string): ResourceMessage[] {
    this.checkOpen();
    return this.db.query<ResourceMessage, [string]>(
      "SELECT * FROM resource_messages WHERE resourceId = ? ORDER BY rowid",
    ).all(identifier(resourceId, "resource id"));
  }
}
