import { test } from "node:test";
import assert from "node:assert/strict";
import execution from "../src/integrations/prime-execution.ts";

test("execution adapter is opt-in and refuses invalid profiles without starting work", async () => {
  const keys = ["ENVINHANDS_AGENT_ID", "ENVINHANDS_MACHINE_ID", "ENVINHANDS_AUDIT_SIGNATURE", "ENVINHANDS_EXECUTION_PROFILES", "ENVINHANDS_CHANGE_SPOOL"];
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    let tools = 0; execution({ registerTool() { tools++; } }); assert.equal(tools, 0);
    Object.assign(process.env, { ENVINHANDS_AGENT_ID: "a", ENVINHANDS_MACHINE_ID: "m", ENVINHANDS_AUDIT_SIGNATURE: "Agent", ENVINHANDS_EXECUTION_PROFILES: "relative", ENVINHANDS_CHANGE_SPOOL: "relative" });
    assert.throws(() => execution({ registerTool() { tools++; } })); assert.equal(tools, 0);
  } finally { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); }
});
