import { expect, test } from "vitest";
import { TailnetRules } from "./tailnet";

function fixture() {
  const dnsName = "fixture.example.ts.net";
  let serve: { TCP: Record<string, { HTTPS: boolean }>; Web: Record<string, { Handlers: Record<string, { Proxy: string }> }>; AllowFunnel: Record<string, boolean> } = { TCP: {}, Web: {}, AllowFunnel: {} };
  const mutations: string[][] = [];
  const rules = new TailnetRules(async (args) => {
    if (args[0] === "status") return JSON.stringify({ BackendState: "Running", Self: { DNSName: `${dnsName}.` } });
    if (args[1] === "status") return JSON.stringify(serve);
    mutations.push(args);
    const port = args.find((a) => a.startsWith("--https="))!.split("=")[1];
    if (args.at(-1) === "off") { delete serve.TCP[port]; delete serve.Web[`${dnsName}:${port}`]; }
    else { serve.TCP[port] = { HTTPS: true }; serve.Web[`${dnsName}:${port}`] = { Handlers: { "/": { Proxy: args.at(-1)! } } }; }
    return "";
  });
  function existing(port: number, proxy = `http://127.0.0.1:${port}`) {
    serve.TCP[port] = { HTTPS: true };
    serve.Web[`${dnsName}:${port}`] = { Handlers: { "/": { Proxy: proxy } } };
  }
  return { rules, serve, mutations, existing, dnsName };
}

test("private rules are created and removed without touching other routes", async () => {
  const { rules, mutations, existing, serve, dnsName } = fixture();
  existing(443, "http://127.0.0.1:38886");
  const rule = await rules.inspect(6360);
  await rules.ensure(rule);
  expect(mutations[0]).toEqual(["serve", "--bg", "--yes", "--https=6360", "http://127.0.0.1:6360"]);
  await rules.remove(rule);
  expect(mutations[1]).toEqual(["serve", "--yes", "--https=6360", "off"]);
  expect(serve.Web[`${dnsName}:443`]).toBeDefined();
  expect(serve.Web[`${dnsName}:6360`]).toBeUndefined();
});

test("existing identical rule requires explicit adoption; changed proxy and Funnel are refused", async () => {
  const { rules, existing, serve, dnsName, mutations } = fixture();
  existing(5995);
  await expect(rules.inspect(5995)).rejects.toThrow("adopt-tailnet-rule");
  const rule = await rules.inspect(5995, true);
  await rules.ensure(rule);
  expect(mutations).toEqual([]);
  existing(5995, "http://127.0.0.1:5996");
  await expect(rules.inspect(5995, true)).rejects.toThrow();
  await expect(rules.remove(rule)).rejects.toThrow("modified externally");
  expect(mutations).toEqual([]);
  existing(5995);
  serve.AllowFunnel[`${dnsName}:5995`] = true;
  await expect(rules.inspect(5995, true)).rejects.toThrow("public Funnel");
  await expect(rules.ensure(rule)).rejects.toThrow("public Funnel");
  expect(mutations).toEqual([]);
});

test("extra handlers are never overwritten or deleted by adoption", async () => {
  const { rules, existing, serve, dnsName, mutations } = fixture();
  existing(5995);
  serve.Web[`${dnsName}:5995`].Handlers["/other"] = { Proxy: "http://127.0.0.1:1234" };
  await expect(rules.inspect(5995, true)).rejects.toThrow();
  expect(mutations).toEqual([]);
});

test("an exactly owned legacy rule on a newly forbidden port can still be cleaned up", async () => {
  const { rules, existing, dnsName, serve, mutations } = fixture();
  existing(443, "http://127.0.0.1:38886");
  existing(5909);
  await rules.remove({ dnsName, port: 5909, proxy: "http://127.0.0.1:5909" });
  expect(mutations).toEqual([["serve", "--yes", "--https=5909", "off"]]);
  expect(serve.Web[`${dnsName}:443`]).toBeDefined();
  expect(serve.Web[`${dnsName}:5909`]).toBeUndefined();
});
