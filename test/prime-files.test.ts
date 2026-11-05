import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import resources from "../src/integrations/prime-files.ts";

test("static analyst can read a shared source file without executing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "env-static-resource-")), prior = process.env.ENVINHANDS_RESOURCE_ROOTS;
  try {
    await writeFile(join(dir, "challenge.py"), "# source-only artifact\nMASK = 45\n");
    process.env.ENVINHANDS_RESOURCE_ROOTS = JSON.stringify([dir]);
    let tool: Parameters<Parameters<typeof resources>[0]["registerTool"]>[0] | undefined; resources({ registerTool(value) { tool = value; } });
    assert.ok(tool);
    const result = await tool.execute("read", { path: join(dir, "challenge.py") });
    assert.notEqual(result.isError, true);
    const data = JSON.parse(result.content[0].text.split("\n").slice(1).join("\n"));
    assert.match(data.text, /MASK = 45/);
  } finally {
    if (prior === undefined) delete process.env.ENVINHANDS_RESOURCE_ROOTS; else process.env.ENVINHANDS_RESOURCE_ROOTS = prior;
    await rm(dir, { recursive: true, force: true });
  }
});
