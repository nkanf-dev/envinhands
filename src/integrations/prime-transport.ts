/** Normal Prime session-bound transport for signed API mutations. */
import {createHash} from "node:crypto";
import {createSignedFetch} from "../signed-fetch.ts";
import {parseRegistration, type AgentRegistrationInput} from "../change-model.ts";
interface Context {sessionManager:{getSessionId():string}}
interface API {on(event:"session_start",handler:(event:unknown,ctx:Context)=>Promise<void>):void}
interface TransportSlot { previous: typeof fetch; wrapped: typeof fetch; registration: () => AgentRegistrationInput; owner: symbol; baseUrl: string }
const slotKey = Symbol.for("envinhands.prime-signed-transport");
const state = globalThis as typeof globalThis & {[slotKey]?: TransportSlot};
/** Host owns disposal after all shutdown hooks; normal reload rebinds one owner. */
export function installPrimeTransport(options:{baseUrl:string;registration:()=>AgentRegistrationInput}):()=>void {
  const owner=Symbol("transport-owner");
  const active=state[slotKey];
  if(active && globalThis.fetch===active.wrapped && active.baseUrl===options.baseUrl){
    active.registration=options.registration;active.owner=owner;
    return ()=>{if(state[slotKey]?.owner===owner && globalThis.fetch===active.wrapped){globalThis.fetch=active.previous;delete state[slotKey];}};
  }
  const previous=globalThis.fetch;
  const slot:TransportSlot={previous,wrapped:previous,registration:options.registration,owner,baseUrl:options.baseUrl};
  const signed=createSignedFetch({baseUrl:options.baseUrl,registration:()=>slot.registration(),fetch:previous.bind(globalThis)});
  slot.wrapped=Object.assign(signed,previous) as typeof fetch;
  globalThis.fetch=slot.wrapped;state[slotKey]=slot;
  return ()=>{if(state[slotKey]?.owner===owner && globalThis.fetch===slot.wrapped){globalThis.fetch=previous;delete state[slotKey];}};
}
export default function primeTransport(pi:API):void {
  const {ENVINHANDS_URL:baseUrl,ENVINHANDS_AGENT_ID:agentId,ENVINHANDS_MACHINE_ID:machineId,ENVINHANDS_AUDIT_SIGNATURE:signature}=process.env;
  if(!baseUrl||!agentId||!machineId||!signature)return;
  let current:AgentRegistrationInput|undefined;
  // One process serves one actual session at a time. No model/provider fetch is modified.
  installPrimeTransport({baseUrl,registration:()=>{if(!current)throw new Error("Session attribution is not initialized");return current;}});
  pi.on("session_start",async(_event,ctx)=>{
    const sessionId=ctx.sessionManager.getSessionId();
    current=parseRegistration({registrationId:"transport-"+createHash("sha256").update(JSON.stringify({agentId,machineId,signature,sessionId})).digest("hex"),agentId,machineId,signature,sessionId});
  });
}
