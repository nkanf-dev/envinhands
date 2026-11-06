import { TeamPrimeConfigError, writeTeamPrimeConfig } from "./team-prime-config.ts";

export interface TeamConfigCliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}
export interface TeamConfigCliDeps {
  /** Test-only override. Production uses the OS home directory. */
  home?: string;
  detectedHostname?: string;
  write?: typeof writeTeamPrimeConfig;
}

/** Configure the team mesh only; this command never creates a Prime agent profile. */
export async function runTeamConfigCli(
  args: string[], env: NodeJS.ProcessEnv, io: TeamConfigCliIO, deps: TeamConfigCliDeps = {},
): Promise<number> {
  const token = env.ENVINHANDS_TOKEN ?? "";
  // Paths and diagnostics can come from the environment or a dependency. Never echo the token.
  const safe = (text: string) => token ? text.split(token).join("[REDACTED]") : text;
  const out = (text: string) => io.stdout(safe(text) + "\n");
  const err = (text: string) => io.stderr(safe(text) + "\n");

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    out("Usage: team-config [--replace]\nSet ENVINHANDS_URL and ENVINHANDS_TOKEN in the environment. Optionally set ENVINHANDS_MACHINE_ID (defaults to the hostname).\n--replace explicitly replaces a different existing team mesh configuration. This command does not create an agent profile.");
    return 0;
  }
  if (args.some(arg => arg !== "--replace") || args.length > 1) {
    err("Invalid arguments. Usage: team-config [--replace]. Set credentials in the environment, not arguments.");
    return 2;
  }
  const missing = [
    !env.ENVINHANDS_URL?.trim() && "ENVINHANDS_URL",
    !token.trim() && "ENVINHANDS_TOKEN",
  ].filter(Boolean);
  if (missing.length) {
    err(`Missing required environment variables: ${missing.join(", ")}. Set them in the environment, not command arguments.`);
    return 2;
  }
  try {
    const result = await (deps.write ?? writeTeamPrimeConfig)(
      { url: env.ENVINHANDS_URL!, token, machineId: env.ENVINHANDS_MACHINE_ID },
      { home: deps.home, detectedHostname: deps.detectedHostname, replace: args.length === 1 },
    );
    out(`status: ${result.status}\npath: ${result.path}\ndiagnostics: connectivity=${result.diagnostics.connectivity}, tunnel=${result.diagnostics.tunnel}, ssh=${result.diagnostics.ssh}\n${result.diagnostics.message}`);
    return 0;
  } catch (error) {
    // Accept only exact, known safe messages. Never print arbitrary errors or input values.
    const message = error instanceof TeamPrimeConfigError ? error.message : "";
    if (message === "Invalid url") err("Invalid ENVINHANDS_URL. Use an HTTPS origin, or HTTP for a loopback origin.");
    else if (message === "Invalid token") err("Invalid ENVINHANDS_TOKEN.");
    else if (message === "Invalid machineId; supply the registered node ID explicitly") err("Invalid ENVINHANDS_MACHINE_ID or hostname. Set ENVINHANDS_MACHINE_ID to the registered node ID.");
    else if (message === "Team configuration already exists and differs; use explicit replace to change it.") err("Team configuration already exists and differs. Use --replace only if you intend to replace it.");
    else if (message === "Cannot securely access team configuration; check permissions, symlinks and available disk space.") err("Cannot securely access team configuration. Check permissions, symlinks and available disk space. On Windows, the PowerShell operation may also have timed out.");
    else err("Team configuration failed. Check the environment and secure file access; an operation may have timed out.");
    return 1;
  }
}
