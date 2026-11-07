import { expect, test } from "bun:test";
import { NativeMesh, qualifiedAgentId } from "../src/integrations/native-mesh.ts";

const rows = Array.from({length: 4101}, (_, i) => {
  const agentId = String(i);
  return {id:qualifiedAgentId("h", agentId), hostId:"h", agentId, parentId:null, name:"n", state:"active" as const, lastHeartbeatAt:"2025-01-01T00:00:00Z", status:"observed" as const};
}).sort((a,b) => a.id.localeCompare(b.id));
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});
function fixture(max: number) {
  const calls: URL[] = [];
  const client = new NativeMesh({baseUrl:"http://localhost",token:"token",fetch: async input => {
    const url = new URL(String(input)); calls.push(url);
    const limit = Number(url.searchParams.get("limit"));
    if (limit > max) return response({},400);
    const after = url.searchParams.get("after");
    if (after) expect(url.searchParams.get("revision")).toBe("42");
    const start = after ? rows.findIndex(row => row.id === after) + 1 : 0;
    const page = rows.slice(start, start + limit);
    return response({version:2,revision:"42",agents:page,nextCursor:start + page.length < rows.length ? page.at(-1)!.id : null});
  }});
  return {client,calls};
}
for (const [max, limits] of [[4000,[4000,4000]], [1000,[4000,1000,1000,1000,1000,1000]], [100,[4000,1000,...Array(42).fill(100)]]] as [number,number[]][]) {
  test(`negotiates ${max} and keeps snapshot for every continuation`, async () => {
    const {client,calls} = fixture(max);
    expect(await client.discover()).toEqual(rows);
    expect(calls.map(url => Number(url.searchParams.get("limit")))).toEqual(limits);
    for (const url of calls.filter(url => url.searchParams.has("after"))) expect(url.searchParams.get("revision")).toBe("42");
  });
}

test("continuation 400 never falls back; other first errors never fall back", async () => {
  for (const status of [400,401,403,413,500,503]) {
    const calls: URL[] = [];
    const client = new NativeMesh({baseUrl:"http://localhost",token:"t",fetch:async input => {
      const url = new URL(String(input)); calls.push(url);
      if (status !== 400 || url.searchParams.has("after")) return response({},status);
      return response({version:2,revision:"1",agents:[rows[0]],nextCursor:rows[0]!.id});
    }});
    await expect(client.discover()).rejects.toMatchObject({status});
    expect(calls.map(url => Number(url.searchParams.get("limit")))).toEqual(status === 400 ? [4000,4000] : [4000]);
  }
});

test("snapshot restart retains negotiated limit and never renegotiates", async () => {
  const calls: URL[] = [];
  const client = new NativeMesh({baseUrl:"http://localhost",token:"t",fetch:async input => {
    const url = new URL(String(input)); calls.push(url);
    if (calls.length === 1) return response({},400);
    if (calls.length === 2) return response({version:2,revision:"1",agents:[rows[0]],nextCursor:rows[0]!.id});
    if (calls.length === 3) return response({},409);
    return response({},400);
  }});
  await expect(client.discover()).rejects.toMatchObject({status:400});
  expect(calls.map(url => Number(url.searchParams.get("limit")))).toEqual([4000,1000,1000,1000]);
  expect(calls[3]!.searchParams.has("after")).toBe(false);
});

test("rejects page larger than negotiated limit and malformed cursor", async () => {
  for (const invalid of ["size", "cursor"]) {
    const client = new NativeMesh({baseUrl:"http://localhost",token:"t",fetch:async input => {
      const limit = Number(new URL(String(input)).searchParams.get("limit"));
      if (limit > 100) return response({},400);
      return invalid === "size" ? response({version:2,revision:"1",agents:rows.slice(0,101),nextCursor:null}) : response({version:2,revision:"1",agents:[rows[0]],nextCursor:rows[1]!.id});
    }});
    await expect(client.discover()).rejects.toThrow("Invalid observations");
  }
});


test("first-page 409 retries without limit fallback", async () => {
  const limits:number[] = [];
  const client = new NativeMesh({baseUrl:"http://localhost",token:"t",fetch:async input => {
    limits.push(Number(new URL(String(input)).searchParams.get("limit")));
    return response({},409);
  }});
  await expect(client.discover()).rejects.toMatchObject({status:409});
  expect(limits).toEqual([4000,4000,4000]);
});

test("byte budget is shared across fallback and snapshot restart", async () => {
  let calls=0, pages=0;
  const limits:number[]=[];
  const client=new NativeMesh({baseUrl:"http://localhost",token:"t",timeoutMs:10000,fetch:async input=>{
    const url=new URL(String(input)); limits.push(Number(url.searchParams.get("limit"))); calls++;
    if (calls === 1) return response({},400);
    if (calls === 11) return response({},409);
    const item=rows[pages++ % 9]!;
    return new Response(JSON.stringify({version:2,revision:calls < 11 ? "1" : "2",agents:[item],nextCursor:item.id}) + " ".repeat(1900000));
  }});
  await expect(client.discover()).rejects.toThrow();
  expect(calls).toBe(20);
  expect(limits[0]).toBe(4000);
  expect(limits.slice(1).every(limit=>limit===1000)).toBe(true);
});


test("record budget is shared across fallback and snapshot restart", async () => {
  const records=Array.from({length:55000},(_,i)=>{
    const agentId=String(i);
    return {id:qualifiedAgentId("h",agentId),hostId:"h",agentId,parentId:null,name:"n",state:"active",lastHeartbeatAt:"2025-01-01T00:00:00Z",status:"observed"};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  let calls=0, starts=0, page=0;
  const limits:number[]=[];
  const client=new NativeMesh({baseUrl:"http://localhost",token:"t",timeoutMs:10000,fetch:async input=>{
    const url=new URL(String(input)); limits.push(Number(url.searchParams.get("limit"))); calls++;
    if (calls===1) return response({},400);
    if (!url.searchParams.has("after")) {starts++; page=0;}
    if (starts===1 && page===55) return response({},409);
    const batch=records.slice(page*1000,++page*1000);
    return response({version:2,revision:String(starts),agents:batch,nextCursor:batch.at(-1)!.id});
  }});
  await expect(client.discover()).rejects.toThrow("Discovery record budget exceeded");
  expect(starts).toBe(2);
  expect(limits[0]).toBe(4000);
  expect(limits.slice(1).every(limit=>limit===1000)).toBe(true);
});
