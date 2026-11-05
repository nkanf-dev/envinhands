/** Deterministic zero-cost provider for real Prime Agent loop validation, not an intelligent model. */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
interface ProviderAPI {
  registerProvider(name: string, config: Record<string, unknown>): void;
  on(event: "before_agent_start", handler: (event: {prompt:string}) => Promise<void>): void;
}

export default async function validationProvider(pi: ProviderAPI): Promise<void> {
  const checkout=process.env.PRIME_AGENT_CHECKOUT;
  if(!checkout)throw new Error("PRIME_AGENT_CHECKOUT is required for the actual fixture provider API.");
  const {registerFauxProvider,getApiProvider,fauxAssistantMessage,fauxToolCall}=await import(pathToFileURL(join(checkout,"packages/ai/src/index.ts")).href);
  const faux = registerFauxProvider({ provider: "envinhands-validation", models: [{ id: "scripted", name: "EnvInHands scripted validation", reasoning: false }] });
  const api = getApiProvider(faux.api);
  if (!api) throw new Error("Fixture provider registration failed.");
  pi.registerProvider(faux.getModel().provider, { api: faux.api, apiKey: "fixture-only-no-network", baseUrl: faux.getModel().baseUrl,
    streamSimple: api.streamSimple, models: faux.models });
  pi.on("before_agent_start", async event => {
    const plan: unknown = JSON.parse(event.prompt);
    if (!Array.isArray(plan) || plan.length > 20 || !plan.every(step => step && typeof step === "object" &&
      typeof step.name === "string" && step.name.startsWith("envinhands_") && step.args && typeof step.args === "object" && !Array.isArray(step.args)))
      throw new Error("Expected a bounded explicit EnvInHands validation tool plan.");
    const declared = plan as Array<{name:string;args:Record<string,unknown>}>;
    faux.setResponses([...declared.map((step,index) => fauxAssistantMessage(fauxToolCall(step.name, step.args, { id: `fixture-${Date.now()}-${index}` }), { stopReason: "toolUse" })),
      fauxAssistantMessage("Scripted validation plan finished. Tool results, not this message, determine acceptance.")]);
  });
}
