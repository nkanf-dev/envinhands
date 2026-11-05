/** Normal opt-in Prime settings; no model, credential or platform dependency. */
import { isAbsolute, join } from "node:path";

export interface PrimeProfile {
  extensions: string[];
  skills: string[];
}
/** Merge these lists into a private per-client settings.json; never overwrite existing settings blindly. */
export function createPrimeProfile(envinhandsRoot: string, primeRoot?: string): PrimeProfile {
  if (!isAbsolute(envinhandsRoot) || (primeRoot !== undefined && !isAbsolute(primeRoot)))
    throw new Error("Prime profile requires an absolute EnvInHands root.");
  return {
    extensions: [
      join(envinhandsRoot, "src", "integrations", "prime-transport.ts"),
      join(envinhandsRoot, "src", "integrations", "prime-collaboration.ts"),
      ...["prime", "prime-execution", "prime-files", "prime-shared-files", "prime-attribution"].map(name => join(envinhandsRoot, "src", "integrations", `${name}.ts`)),
    ],
    skills: ["envinhands-resources", "envinhands-agent-messaging"].map(name => join(envinhandsRoot, ".prime", "agent", "skills", name, "SKILL.md")),
  };
}
