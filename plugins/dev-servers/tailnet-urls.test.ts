import { expect, test } from "vitest";
import { TailnetUrlResolver, VERIFIED_URL_GRACE_MS } from "./tailnet-urls";

const url = (port: number) => `https://fixture.example.ts.net:${port}`;

test("concurrent discovery shares one read and filters each caller's ports", async () => {
  let calls = 0;
  let finish!: (value: Map<number, string>) => void;
  const resolver = new TailnetUrlResolver({ read: () => { calls++; return new Promise((resolve) => { finish = resolve; }); } });
  const first = resolver.get([5910]);
  const second = resolver.get([5970]);
  finish(new Map([[5910, url(5910)], [5970, url(5970)]]));
  expect(await first).toEqual(new Map([[5910, url(5910)]]));
  expect(await second).toEqual(new Map([[5970, url(5970)]]));
  expect(calls).toBe(1);
});

test("an initial transient Tailscale failure gets one bounded retry", async () => {
  let calls = 0;
  let retries = 0;
  const resolver = new TailnetUrlResolver({
    read: async () => { if (++calls === 1) throw new Error("EADDRNOTAVAIL"); return new Map([[5970, url(5970)]]); },
    retryDelay: async () => { retries++; },
  });
  expect(await resolver.get([5970])).toEqual(new Map([[5970, url(5970)]]));
  expect([calls, retries]).toEqual([2, 1]);
});

test("transient read errors preserve recently verified URLs, log once, and never invent a route", async () => {
  let fail = false;
  const errors: unknown[] = [];
  const resolver = new TailnetUrlResolver({
    read: async () => { if (fail) throw new Error("EADDRNOTAVAIL"); return new Map([[5970, url(5970)]]); },
    onError: (cause) => errors.push(cause),
  });
  await resolver.get([5970]);
  fail = true;
  expect(await resolver.get([5970, 5990])).toEqual(new Map([[5970, url(5970)]]));
  expect(await resolver.get([5970])).toEqual(new Map([[5970, url(5970)]]));
  expect(errors).toHaveLength(1);
});

test("a verified route is not retained past the error grace period", async () => {
  let now = 1;
  let fail = false;
  let calls = 0;
  const resolver = new TailnetUrlResolver({ now: () => now, retryDelay: async () => {}, read: async () => {
    calls++;
    if (fail) throw new Error("offline");
    return new Map([[5970, url(5970)]]);
  } });
  await resolver.get([5970]);
  now += VERIFIED_URL_GRACE_MS;
  fail = true;
  expect(await resolver.get([5970])).toEqual(new Map());
  expect(calls).toBe(3);
});

test("a successful read removing a route clears it immediately, including during later errors", async () => {
  let result = new Map([[5970, url(5970)]]);
  let fail = false;
  const resolver = new TailnetUrlResolver({ read: async () => { if (fail) throw new Error("offline"); return result; } });
  await resolver.get([5970]);
  result = new Map();
  expect(await resolver.get([5970])).toEqual(new Map());
  fail = true;
  expect(await resolver.get([5970])).toEqual(new Map());
});
