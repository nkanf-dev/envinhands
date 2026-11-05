import { test } from "node:test";
import assert from "node:assert/strict";
import { assessCandidates, NoAvailableTransportError, selectTransport } from "../src/transports/policy.ts";
import type { SelectionOptions, TransportCandidate } from "../src/transports/policy.ts";

const options: SelectionOptions = { now: 10_000, maxAgeMs: 1_000, priority: [] };
const candidate = (id: string, changes: Partial<TransportCandidate> = {}): TransportCandidate => ({
  id, source: id, enabled: true, configured: true,
  probe: { status: "healthy", checkedAt: 9_500 }, ...changes,
});

test("distinguishes reachable, probe failure, unknown, stale and invalid observations", () => {
  const candidates = [candidate("ok"), candidate("failed", { probe: { status: "failed", checkedAt: 9_999 } }),
    candidate("missing", { probe: undefined }), candidate("boundary", { probe: { status: "healthy", checkedAt: 9_000 } }),
    candidate("old-failure", { probe: { status: "failed", checkedAt: 8_999 } }),
    candidate("future", { probe: { status: "healthy", checkedAt: 10_001 } }),
    candidate("nan", { probe: { status: "healthy", checkedAt: NaN } }),
    candidate("bad-status", { probe: { status: "maybe", checkedAt: 9_999 } as never })];
  assert.deepEqual(assessCandidates(candidates, options).map(({ status, reason }) => [status, reason]), [
    ["reachable", "healthy"], ["failed", "probe-failed"], ["unknown", "never-probed"],
    ["unknown", "stale-probe"], ["unknown", "stale-probe"], ["unknown", "invalid-probe"],
    ["unknown", "invalid-probe"], ["unknown", "invalid-probe"],
  ]);
  assert.equal(selectTransport(candidates, { ...options, priority: ["future", "boundary", "ok"] }).id, "ok");
});

test("uses explicit user priority then input order, independent of source name", () => {
  const candidates = [candidate("direct"), candidate("reverse relay"), candidate("UU"), candidate("frp"), candidate("tailscale")];
  assert.equal(selectTransport(candidates, { ...options, priority: ["tailscale", "direct"] }).id, "tailscale");
  assert.equal(selectTransport(candidates, { ...options, priority: ["not-present", "frp", "frp"] }).id, "frp");
  assert.equal(selectTransport(candidates, options).id, "direct");
  assert.equal(selectTransport(candidates.slice(1), options).id, "reverse relay");
});

test("disabled and unconfigured candidates cannot be selected even with healthy probes", () => {
  const candidates = [candidate("disabled", { enabled: false }), candidate("uninstalled", { configured: false }), candidate("available")];
  assert.deepEqual(assessCandidates(candidates, options).map((x) => x.status), ["disabled", "unconfigured", "reachable"]);
  assert.equal(selectTransport(candidates, { ...options, priority: ["disabled", "uninstalled", "available"] }).id, "available");
});

test("connection failures are excluded for subsequent selections, with explicit exhaustion", () => {
  const candidates = [candidate("direct"), candidate("relay"), candidate("third")];
  const priority = ["relay", "direct", "third"];
  assert.equal(selectTransport(candidates, { ...options, priority }).id, "relay");
  assert.equal(selectTransport(candidates, { ...options, priority, attemptedFailures: ["relay"] }).id, "direct");
  assert.equal(selectTransport(candidates, { ...options, priority, attemptedFailures: ["relay", "direct"] }).id, "third");
  assert.throws(() => selectTransport(candidates, { ...options, priority, attemptedFailures: ["relay", "direct", "third"] }), (err: unknown) => {
    assert.ok(err instanceof NoAvailableTransportError);
    assert.equal(err.assessments.length, 3);
    assert.deepEqual(err.attemptedFailures, ["relay", "direct", "third"]);
    return true;
  });
});

test("all unavailable or no candidates fail explicitly", () => {
  for (const candidates of [[], [candidate("failed", { probe: { status: "failed", checkedAt: 9_999 } }),
    candidate("unknown", { probe: undefined }), candidate("off", { enabled: false }), candidate("unconfigured", { configured: false })]]) {
    assert.throws(() => selectTransport(candidates, options), NoAvailableTransportError);
  }
});

test("invalid timing and duplicate candidate IDs fail closed", () => {
  for (const patch of [{ maxAgeMs: 0 }, { maxAgeMs: Infinity }, { maxAgeMs: -1 }, { now: NaN }]) {
    assert.throws(() => assessCandidates([candidate("one")], { ...options, ...patch }), RangeError);
  }
  assert.throws(() => assessCandidates([candidate("x"), candidate("x")], options), /unique/);
});
