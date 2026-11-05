/** Durable caller-owned spool. Pending local evidence is not a server receipt. */
import { mkdir, open, readFile, readdir, unlink, link } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseRegistration, parseChange, type AgentRegistrationInput, type ChangeInput } from "./change-model.ts";
import type { ChangeClient } from "./change-client.ts";

const filename = (requestId: string) => createHash("sha256").update(requestId).digest("hex") + ".json";

export interface PendingChange { registration: AgentRegistrationInput; change: ChangeInput }
async function directorySync(path: string): Promise<void> {
  // Windows does not expose POSIX directory fsync through node:fs. File fsync
  // remains required; this is a platform durability limit, not silent recovery.
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
export class ChangeSpool {
  constructor(readonly directory: string) {}
  /** Persists the exact request before any network operation. No credentials. */
  async enqueue(registration: AgentRegistrationInput, change: ChangeInput): Promise<void> {
    const pending = { registration: parseRegistration(registration), change: parseChange(change) };
    if (pending.registration.registrationId !== pending.change.registrationId) throw new Error("Registration does not match change");
    const content = JSON.stringify(pending);
    if (new TextEncoder().encode(JSON.stringify(pending.change)).length > 16384) throw new Error("Change request too large");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, filename(pending.change.requestId));
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
      // Publishing by hard link is atomic and cannot overwrite a competing writer.
      // A crash before publication leaves only a .tmp file, never a partial request.
      try { await link(temporary, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await readFile(path, "utf8") !== content) throw new Error("Local change request ID conflict");
      }
    } finally { await unlink(temporary); }
    await directorySync(this.directory);
  }
  /** Reserve a logical operation before effects. Never replay a started operation. */
  async reserveOperation(registrationId: string, operationId: string): Promise<void> {
    const directory = join(this.directory, "operations");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const name = createHash("sha256").update(JSON.stringify({ registrationId, operationId })).digest("hex");
    let file;
    try { file = await open(join(directory, name + ".json"), "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Operation already started; inspect its recorded result instead of replaying it");
      throw error;
    }
    try { await file.writeFile(JSON.stringify({ registrationId, operationId })); await file.sync(); }
    finally { await file.close(); }
    await directorySync(directory);
  }
  /** Explicit flush; a failed/uncertain record stays pending with its original ID. */
  async flush(client: ChangeClient): Promise<{ synced: string[]; pending: number }> {
    let names: string[];
    try { names = (await readdir(this.directory)).filter(name => name.endsWith(".json")).sort(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { synced: [], pending: 0 };
      throw error;
    }
    const synced: string[] = [];
    for (const name of names) {
      const path = join(this.directory, name);
      const saved = JSON.parse(await readFile(path, "utf8")) as PendingChange;
      const registration = parseRegistration(saved.registration), change = parseChange(saved.change);
      if (filename(change.requestId) !== name || change.registrationId !== registration.registrationId) throw new Error("Invalid local change record");
      await client.register(registration);
      await client.recordChange(change);
      // Remove only after both authenticated service responses have been validated.
      await unlink(path);
      await directorySync(this.directory);
      synced.push(change.requestId);
    }
    return { synced, pending: 0 };
  }
}
