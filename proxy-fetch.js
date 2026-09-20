(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LeakredProxyFetch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function firstSuccessful(attempts) {
    return new Promise((resolve, reject) => {
      const errors = [];
      let remaining = attempts.length;

      attempts.forEach((attempt, index) => {
        Promise.resolve(attempt).then(resolve, (error) => {
          errors[index] = error;
          remaining -= 1;
          if (remaining === 0) reject(new Error("Every proxy request failed"));
        });
      });
    });
  }

  function createProxyFetcher({ proxyBuilders, fetchImpl, timeoutMs }) {
    const request = fetchImpl || fetch.bind(globalThis);

    return async function fetchViaProxies(targetUrl, {
      method = "GET",
      body = null,
      headers = {},
      parseJson = false,
    } = {}) {
      const controllers = proxyBuilders.map(() => new AbortController());
      const attempts = proxyBuilders.map((buildProxy, index) => {
        const controller = controllers[index];
        const options = { method, headers, signal: controller.signal };
        if (body != null) options.body = body;

        const response = request(buildProxy(targetUrl), options)
          .then(async (res) => {
            if (!res.ok) throw new Error("HTTP " + res.status);
            const text = await res.text();
            if (!text) throw new Error("Empty body");
            if (!parseJson) return text;
            try {
              return JSON.parse(text);
            } catch {
              throw new Error("Bad JSON");
            }
          });
        let timeoutId;
        const deadline = new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            controller.abort();
            reject(new Error("Proxy request timed out"));
          }, timeoutMs);
        });

        return Promise.race([response, deadline]).finally(() => clearTimeout(timeoutId));
      });

      try {
        const result = await firstSuccessful(attempts);
        controllers.forEach((controller) => controller.abort());
        return result;
      } catch (error) {
        throw new Error("All CORS proxies failed.", { cause: error });
      }
    };
  }

  return { createProxyFetcher };
});
