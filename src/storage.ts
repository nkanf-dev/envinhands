/** Standalone SQLite storage. This is not connected to the control handler. */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Machine, ResourceMessage } from "./control.ts";

export interface RegisterMachine {
  id: string;
  name: string;
  host: string;
  os: string;
  sshPort?: number;
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
  private constructor(private readonly db: Database) {}

  static open(path: string): Storage {
    if (typeof path !== "string" || path.length === 0) throw new Error("Invalid database path");
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
      return new Storage(db);
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

  registerMachine(input: RegisterMachine): Machine {
    this.checkOpen();
    if (input === null || typeof input !== "object") throw new Error("Invalid machine");
    const id = identifier(input.id, "id");
    const name = text(input.name, "name", 200);
    const host = text(input.host, "host", 253);
    const os = text(input.os, "os", 100);
    const sshPort = input.sshPort === undefined ? 22 : input.sshPort;
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) throw new Error("Invalid sshPort");
    const machine: Machine = { id, name, host, os, sshPort, registeredAt: new Date().toISOString(), lastHeartbeatAt: null };
    this.db.query(`INSERT INTO machines (id, name, host, os, sshPort, registeredAt, lastHeartbeatAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, name, host, os, sshPort, machine.registeredAt, null);
    return machine;
  }

  getMachine(id: string): Machine | null {
    this.checkOpen();
    return this.db.query<Machine, [string]>("SELECT * FROM machines WHERE id = ?").get(identifier(id, "id"));
  }

  listMachines(os?: string): Machine[] {
    this.checkOpen();
    if (os === undefined) return this.db.query<Machine, []>("SELECT * FROM machines ORDER BY rowid").all();
    const value = text(os, "os", 100);
    return this.db.query<Machine, [string]>("SELECT * FROM machines WHERE os = ? ORDER BY rowid").all(value);
  }

  /** Records the receipt time only; it does not check machine availability. */
  recordHeartbeat(id: string): Machine {
    this.checkOpen();
    const machine = this.db.query<Machine, [string, string]>(
      "UPDATE machines SET lastHeartbeatAt = ? WHERE id = ? RETURNING *",
    ).get(new Date().toISOString(), identifier(id, "id"));
    if (!machine) throw new Error("Machine not found");
    return machine;
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
