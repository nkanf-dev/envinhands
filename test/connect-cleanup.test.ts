import { test, expect } from "bun:test";

// An awaited runCli result is not enough: a leaked deadline can keep the real
// process alive after that result. The fixture owns no network or user state.
for (const mode of ["error", "error-reject", "declared", "large", "invalid", "cancel", "deadline", "fallback-interactive"]) {
  test.skipIf(mode === "fallback-interactive" && process.platform === "win32")(`connect releases request resources on ${mode}`, async () => {
    const child = Bun.spawn([process.execPath, "run", "test/fixtures/connect-cleanup-child.ts", mode], {
      stdin:"ignore", stdout:"pipe", stderr:"pipe",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([child.exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("fixture process did not exit")), 2000);
      })]);
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({code, stdout:stdout.trim(), stderr}).toEqual({code:0, stdout:"fixture-complete", stderr:""});
    } finally { if (timer) clearTimeout(timer); child.kill(); await child.exited; }
  }, 5000);
}
