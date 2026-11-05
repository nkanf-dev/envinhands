/**
 * A selection policy only. It does not probe, connect, install transports, or
 * migrate existing SSH sessions. The caller supplies observations from real
 * transport probes and is responsible for performing a fresh connection.
 */
export interface TransportCandidate {
  /** Unique within a selection. Source names are opaque, not adapter types. */
  id: string;
  source: string;
  enabled: boolean;
  configured: boolean;
  /** Most recent actual probe, measured in the same clock as `now`. */
  probe?: { status: "healthy" | "failed"; checkedAt: number };
}

export type CandidateStatus = "disabled" | "unconfigured" | "reachable" | "failed" | "unknown";
export type AssessmentReason = "disabled" | "unconfigured" | "healthy" | "probe-failed" |
  "never-probed" | "stale-probe" | "invalid-probe";
export interface CandidateAssessment {
  candidate: TransportCandidate;
  status: CandidateStatus;
  reason: AssessmentReason;
}

export interface SelectionOptions {
  /** Candidate IDs in preference order; unlisted IDs follow in input order. */
  priority: readonly string[];
  /** Maximum probe age in milliseconds; exactly this old is already stale. */
  maxAgeMs: number;
  /** Current epoch milliseconds, injected so policy and tests are deterministic. */
  now: number;
  /** IDs whose connection attempt already failed during this selection cycle. */
  attemptedFailures?: readonly string[];
}

export class NoAvailableTransportError extends Error {
  readonly assessments: readonly CandidateAssessment[];
  readonly attemptedFailures: readonly string[];

  constructor(assessments: readonly CandidateAssessment[], attemptedFailures: readonly string[]) {
    super("No available transport remains; a new connection cannot be selected.");
    this.name = "NoAvailableTransportError";
    this.assessments = assessments;
    this.attemptedFailures = [...attemptedFailures];
  }
}

/** Evaluate point-in-time observations; neither a probe nor a connection is made. */
export function assessCandidates(
  candidates: readonly TransportCandidate[], options: Pick<SelectionOptions, "now" | "maxAgeMs">,
): CandidateAssessment[] {
  if (!Number.isFinite(options.now) || !Number.isFinite(options.maxAgeMs) || options.maxAgeMs <= 0) {
    throw new RangeError("now must be finite and maxAgeMs must be finite and positive");
  }
  const ids = new Set<string>();
  return candidates.map((candidate) => {
    if (!candidate || typeof candidate.id !== "string" || !candidate.id || ids.has(candidate.id)) {
      throw new Error("Each transport candidate must have a unique non-empty ID");
    }
    ids.add(candidate.id);
    if (candidate.enabled !== true) return { candidate, status: "disabled", reason: "disabled" };
    if (candidate.configured !== true) return { candidate, status: "unconfigured", reason: "unconfigured" };
    const probe = candidate.probe;
    if (probe === undefined || probe === null) return { candidate, status: "unknown", reason: "never-probed" };
    if ((probe.status !== "healthy" && probe.status !== "failed") ||
        !Number.isFinite(probe.checkedAt) || probe.checkedAt > options.now) {
      return { candidate, status: "unknown", reason: "invalid-probe" };
    }
    if (options.now - probe.checkedAt >= options.maxAgeMs) {
      return { candidate, status: "unknown", reason: "stale-probe" };
    }
    if (probe.status === "failed") return { candidate, status: "failed", reason: "probe-failed" };
    return { candidate, status: "reachable", reason: "healthy" };
  });
}

/**
 * Pick a fresh healthy candidate. To retry after an actual connection failure,
 * call again with that candidate's ID added to attemptedFailures. This selects
 * a route for a new connection; it never moves or resumes an SSH session.
 * Throws NoAvailableTransportError if there is no eligible, untried candidate.
 */
export function selectTransport(candidates: readonly TransportCandidate[], options: SelectionOptions): TransportCandidate {
  const assessments = assessCandidates(candidates, options);
  const failed = new Set(options.attemptedFailures ?? []);
  const ranks = new Map<string, number>();
  options.priority.forEach((id, index) => { if (!ranks.has(id)) ranks.set(id, index); });
  let selected: TransportCandidate | undefined;
  let bestRank = Infinity;
  for (const assessment of assessments) {
    if (assessment.status !== "reachable" || failed.has(assessment.candidate.id)) continue;
    const rank = ranks.get(assessment.candidate.id) ?? Infinity;
    if (selected === undefined || rank < bestRank) {
      selected = assessment.candidate;
      bestRank = rank;
    }
  }
  if (!selected) throw new NoAvailableTransportError(assessments, options.attemptedFailures ?? []);
  return selected;
}
