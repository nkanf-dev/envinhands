import {test} from "node:test";
import assert from "node:assert/strict";
import {createSignedFetch} from "../src/signed-fetch.ts";
import {installPrimeTransport} from "../src/integrations/prime-transport.ts";
const registration={registrationId:"transport-test",agentId:"agent",sessionId:"session",machineId:"client",signature:"Transport test"};
test("signed fetch adds mutation declaration only to same service origin and avoids audit recursion",async()=>{
 const calls:Array<{url:string;headers:Headers}>=[];
 const fetcher=async(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{calls.push({url:String(input),headers:new Headers(init?.headers)});return new Response("{}");};
 const signed=createSignedFetch({baseUrl:"https://control.example",registration:()=>registration,fetch:fetcher,operationId:()=>"op-one"});
 for(const [url,method]of[["https://control.example/v1/messages","POST"],["https://control.example/v1/changes","POST"],["https://control.example/v1/messages","GET"],["https://model.example/v1/messages","POST"]])await signed(url,{method,headers:{authorization:"Bearer private-fixture"}});
 assert.deepEqual(JSON.parse(Buffer.from(calls[0].headers.get("x-envinhands-registration")!,"base64url").toString()),registration);
 assert.equal(calls[0].headers.get("x-envinhands-operation-id"),"op-one");assert.equal(calls[0].headers.get("authorization"),"Bearer private-fixture");
 for(const call of calls.slice(1))assert.equal(call.headers.get("x-envinhands-registration"),null);
});
test("owned Prime transport disposal does not overwrite a later fetch owner",async()=>{
 const original=globalThis.fetch;const fake=Object.assign(async()=>new Response("{}"),original);globalThis.fetch=fake as typeof fetch;
 try{
  const dispose=installPrimeTransport({baseUrl:"https://control.example",registration:()=>registration});const installed=globalThis.fetch;assert.notEqual(installed,fake);
  const later=Object.assign(async()=>new Response("{}"),original);globalThis.fetch=later as typeof fetch;dispose();assert.equal(globalThis.fetch,later);
  globalThis.fetch=fake as typeof fetch;const ownDispose=installPrimeTransport({baseUrl:"https://control.example",registration:()=>registration});ownDispose();assert.equal(globalThis.fetch,fake);
 }finally{globalThis.fetch=original;}
});

test("normal session reload rebinds one fetch owner and keeps explicit request attribution",async()=>{
 const original=globalThis.fetch;const actors:string[]=[];
 const fake=Object.assign(async(_input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{actors.push(JSON.parse(Buffer.from(new Headers(init?.headers).get("x-envinhands-registration")!,"base64url").toString()).agentId);return new Response("{}");},original);
 globalThis.fetch=fake as typeof fetch;
 try{
  const disposeA=installPrimeTransport({baseUrl:"https://control.example",registration:()=>registration});const first=globalThis.fetch;
  const newer={...registration,registrationId:"reg-b",agentId:"agent-b",sessionId:"session-b"};
  const disposeB=installPrimeTransport({baseUrl:"https://control.example",registration:()=>newer});assert.equal(globalThis.fetch,first);
  await globalThis.fetch("https://control.example/v1/messages",{method:"POST"});assert.deepEqual(actors,["agent-b"]);
  disposeA();assert.equal(globalThis.fetch,first);
  await globalThis.fetch("https://control.example/v1/messages",{method:"POST",headers:{"x-envinhands-registration":Buffer.from(JSON.stringify(registration)).toString("base64url"),"x-envinhands-operation-id":"request-from-a"}});
  assert.deepEqual(actors,["agent-b","agent"]);disposeB();assert.equal(globalThis.fetch,fake);
 }finally{globalThis.fetch=original;}
});
