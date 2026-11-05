/** Mutation boundary usable from any integration, not a global filesystem watcher. */
import { randomUUID } from "node:crypto";
import { ChangeSpool } from "./change-spool.ts";
import { parseChange, parseRegistration, type AgentRegistrationInput, type ChangeInput, type ChangeOutcome } from "./change-model.ts";

export interface MutationResult {
  outcome: ChangeOutcome;
  beforeSha256?: string | null;
  afterSha256?: string | null;
  evidenceRef?: string | null;
}
export interface AuditedOperationResult {
  operationId: string;
  startedRequestId: string;
  completedRequestId: string | null;
  outcome: ChangeOutcome;
  locallyRecorded: boolean;
  synced: false;
}
/**
 * A durable intent precedes the callback. The outcome is a separate append event.
 * Callback errors mean unknown effects, never automatic retry. Network sync is
 * separate so an unavailable control host does not erase the local evidence.
 */
export async function runAuditedOperation(registration: AgentRegistrationInput,
  change: Omit<ChangeInput, "requestId" | "outcome" | "occurredAt">,
  spool: ChangeSpool, mutate: () => Promise<MutationResult>): Promise<AuditedOperationResult> {
  const identity = parseRegistration(registration);
  const initial = parseChange({ ...change, requestId: randomUUID(), outcome: "unknown", occurredAt: new Date().toISOString() });
  await spool.reserveOperation(identity.registrationId, initial.operationId);
  await spool.enqueue(identity, initial); // Cannot start a mutation without durable intent.
  let result: MutationResult;
  try { result = await mutate(); }
  catch { result = { outcome: "unknown" }; }
  let completedRequestId: string | null = null;
  try {
    const completed = parseChange({ ...initial, requestId: randomUUID(), outcome: result.outcome,
      occurredAt: new Date().toISOString(), beforeSha256: result.beforeSha256 === undefined ? initial.beforeSha256 : result.beforeSha256,
      afterSha256: result.afterSha256 ?? null, evidenceRef: result.evidenceRef ?? initial.evidenceRef });
    await spool.enqueue(identity, completed, initial.requestId);
    completedRequestId = completed.requestId;
    return { operationId: initial.operationId, startedRequestId: initial.requestId, completedRequestId,
      outcome: result.outcome, locallyRecorded: true, synced: false };
  } catch {
    // The first durable record still says unknown; never claim completion was recorded.
    return { operationId: initial.operationId, startedRequestId: initial.requestId, completedRequestId,
      outcome: "unknown", locallyRecorded: false, synced: false };
  }
}
