import { createPrimeProfile } from "./integrations/prime-profile.ts";

/** Output config only. Existing client settings and credentials are never read or written. */
export function runPrimeProfileCli(args: string[], io: {write(text: string): void; error(text: string): void}): number {
  try {
    if (args.length !== 2) throw new Error();
    io.write(JSON.stringify(createPrimeProfile(args[0], args[1]), null, 2) + "\n");
    return 0;
  } catch {
    io.error("Use prime-profile with absolute EnvInHands and prepared Prime checkout roots. Output is a settings fragment, not a configured or registered Agent.\n");
    return 1;
  }
}
