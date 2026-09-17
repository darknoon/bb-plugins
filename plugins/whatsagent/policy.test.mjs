// Board posting policy: pure checks that run without a bb host.
//   node --test policy.test.mjs   (after `npm run build`, which emits dist/server.js)
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoSelfReference, normalizePostBody, BoardError } from "./dist/server.js";

const me = "thr_nfaca7jtvk";

test("a thread member may not reference its own thread id", () => {
  assert.throws(() => assertNoSelfReference("Done: previews shipped — thr_nfaca7jtvk", me), (e) => e instanceof BoardError && /Remove thr_nfaca7jtvk/.test(e.message));
});

test("the id is matched as a whole token, anywhere in the body", () => {
  assert.throws(() => assertNoSelfReference("see thr_nfaca7jtvk for details", me), BoardError);
  assert.throws(() => assertNoSelfReference("(thr_nfaca7jtvk)", me), BoardError);
  assert.doesNotThrow(() => assertNoSelfReference("see thr_nfaca7jtvkx", me), "a longer id that merely starts the same is a different thread");
});

test("referencing a different thread still posts", () => {
  assert.doesNotThrow(() => assertNoSelfReference("Blocked on thr_rden4mbx6p's sweep; needs a decision", me));
});

test("humans and plugin identities are exempt (no own thread)", () => {
  assert.doesNotThrow(() => assertNoSelfReference("mentioning thr_nfaca7jtvk from the page", null));
});

test("the limit still applies alongside", () => {
  assert.throws(() => normalizePostBody("x".repeat(200), 160), BoardError);
  assert.equal(normalizePostBody("  ok  ", 160), "ok");
});
