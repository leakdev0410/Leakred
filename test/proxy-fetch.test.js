const assert = require("node:assert/strict");
const test = require("node:test");

const { createProxyFetcher } = require("../proxy-fetch.js");

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

test("returns a valid response without waiting for an earlier stalled proxy", async () => {
  const fetchViaProxies = createProxyFetcher({
    proxyBuilders: [
      (url) => `https://slow.example/?${url}`,
      (url) => `https://fast.example/?${url}`,
    ],
    fetchImpl: async (url) => {
      if (url.startsWith("https://slow.example")) return new Promise(() => {});
      return response("ready");
    },
    timeoutMs: 1_000,
  });

  const result = await Promise.race([
    fetchViaProxies("https://provider.example/media"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("waited for stalled proxy")), 50)),
  ]);

  assert.equal(result, "ready");
});

test("rejects when every proxy returns an invalid response", async () => {
  const fetchViaProxies = createProxyFetcher({
    proxyBuilders: [(url) => `https://failed.example/?${url}`],
    fetchImpl: async () => response("", 503),
    timeoutMs: 1_000,
  });

  await assert.rejects(
    fetchViaProxies("https://provider.example/media"),
    /All CORS proxies failed/,
  );
});

test("rejects after the deadline when a proxy ignores an abort signal", async () => {
  const fetchViaProxies = createProxyFetcher({
    proxyBuilders: [(url) => `https://stalled.example/?${url}`],
    fetchImpl: async () => new Promise(() => {}),
    timeoutMs: 10,
  });

  const result = await Promise.race([
    fetchViaProxies("https://provider.example/media").then(
      () => "resolved",
      (error) => error.message,
    ),
    new Promise((resolve) => setTimeout(() => resolve("still pending"), 50)),
  ]);

  assert.equal(result, "All CORS proxies failed.");
});

test("does not require Promise.any to return the first valid proxy response", async () => {
  const fetchViaProxies = createProxyFetcher({
    proxyBuilders: [
      (url) => `https://failed.example/?${url}`,
      (url) => `https://working.example/?${url}`,
    ],
    fetchImpl: async (url) => url.startsWith("https://failed.example")
      ? response("", 502)
      : response("compatible"),
    timeoutMs: 1_000,
  });
  const promiseAny = Promise.any;
  Promise.any = undefined;

  try {
    assert.equal(await fetchViaProxies("https://provider.example/media"), "compatible");
  } finally {
    Promise.any = promiseAny;
  }
});

test("rejects when every proxy fails without AggregateError support", async () => {
  const fetchViaProxies = createProxyFetcher({
    proxyBuilders: [(url) => `https://failed.example/?${url}`],
    fetchImpl: async () => response("", 502),
    timeoutMs: 1_000,
  });
  const aggregateError = global.AggregateError;
  global.AggregateError = undefined;

  try {
    const result = await Promise.race([
      fetchViaProxies("https://provider.example/media").then(
        () => "resolved",
        (error) => error.message,
      ),
      new Promise((resolve) => setTimeout(() => resolve("still pending"), 50)),
    ]);
    assert.equal(result, "All CORS proxies failed.");
  } finally {
    global.AggregateError = aggregateError;
  }
});
