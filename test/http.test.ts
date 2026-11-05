import { test } from "node:test";
import assert from "node:assert/strict";
import { bearerAuth, json, HttpError, fields, bodyBytes } from "../src/http.ts";

test("shared bearer boundary requires exact credentials and does not normalize attackers", () => {
  const authorized = bearerAuth("test-token");
  for (const token of ["", " ", "x\ny"]) assert.throws(() => bearerAuth(token));
  assert.equal(authorized(new Request("http://local.test", { headers: { authorization: "Bearer test-token" } })), true);
  for (const auth of ["", "bearer test-token", "Bearer wrong", "test-token"])
    assert.equal(authorized(new Request("http://local.test", { headers: { authorization: auth } })), false);
  assert.equal(authorized(new Request("http://local.test")), false);
});

test("HTTP decoding shares bounded streamed and declared bodies, exact UTF8 JSON objects and allowed keys", async () => {
  const request = (body: NonNullable<RequestInit["body"]>, headers?: RequestInit["headers"]) => new Request("http://local.test", { method: "POST", body, headers, duplex: "half" });
  assert.deepEqual(await json(request('{"value":"ok"}')), { value: "ok" });
  for (const value of ["[]", "null", "1", "{", "\"text\""])
    await assert.rejects(json(request(value)), (e: unknown) => e instanceof HttpError && e.status === 400);
  await assert.rejects(json(request(new Uint8Array([0xff]))), HttpError);
  await assert.rejects(bodyBytes(request("x", { "content-length": "invalid" })), HttpError);
  await assert.rejects(bodyBytes(request("{}", { "content-length": "16385" })), (e: unknown) => e instanceof HttpError && e.status === 413);
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(16385)); c.close(); } });
  await assert.rejects(bodyBytes(request(stream)), (e: unknown) => e instanceof HttpError && e.status === 413);
  assert.throws(() => fields({ value: 1, typo: 2 }, ["value"]), HttpError);
  assert.doesNotThrow(() => fields({ value: 1 }, ["value"]));
});
