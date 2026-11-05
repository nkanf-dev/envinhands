/** Normal opt-in Prime settings; no model, credential or platform dependency. */
import { isAbsolute, join } from "node:path";

export interface PrimeProfile {
  extensions: string[];
  skills: string[];
}
/** Merge these lists into a private per-client settings.json; never overwrite existing settings blindly. */
export function createPrimeProfile(envinhandsRoot: string, primeRoot: string): PrimeProfile {
  if (![envinhandsRoot, primeRoot].every(value => typeof value === "string" && isAbsolute(value)))
    throw new Error("Prime profile requires absolute EnvInHands and Prime roots.");
  return {
    extensions: [
      ...["heartbeat", "messages", "resources"].map(name => join(primeRoot, "packages", "coding-agent", "examples", "extensions", `envinhands-${name}.ts`)),
      ...["prime", "prime-execution", "prime-files", "prime-attribution"].map(name => join(envinhandsRoot, "src", "integrations", `${name}.ts`)),
    ],
    skills: ["envinhands-resources", "envinhands-agent-messaging"].map(name => join(envinhandsRoot, ".prime", "agent", "skills", name, "SKILL.md")),
  };
}
