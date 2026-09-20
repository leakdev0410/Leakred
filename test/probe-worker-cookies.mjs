// Simulate Worker's request flow: first GET to harvest cookies, then GET /p/...
// Using Cloudflare Worker's browser-like headers (Sec-Ch-Ua, etc.)

const SEC_CH_UA = '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"';

async function fetchWithCookieTracking(url, headers) {
  const res = await fetch(url, { headers, redirect: "follow" });
  const setCookies = res.headers.getSetCookie?.() || [];
  let existingCookies = headers.Cookie || "";
  for (const sc of setCookies) {
    const [pair] = sc.split(";");
    const [name, value] = pair.split("=");
    if (name && value) {
      const re = new RegExp(`(?:^|;\\s*)${name}=[^;]+`);
      existingCookies = existingCookies.replace(re, "").trim();
      existingCookies = existingCookies ? `${existingCookies}; ${name}=${value}` : `${name}=${value}`;
    }
  }
  return { status: res.status, cookies: existingCookies, text: await res.text() };
}

let cookies = "";
const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Sec-Ch-Ua": SEC_CH_UA,
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

// Step 1: GET instagram.com
const r1 = await fetchWithCookieTracking("https://www.instagram.com/", { ...headers, Cookie: cookies });
cookies = r1.cookies;
console.log("After GET /: status=", r1.status, "cookies=", cookies.slice(0, 200));

// Step 2: Second GET to harvest more cookies
const r2 = await fetchWithCookieTracking("https://www.instagram.com/", { ...headers, Cookie: cookies });
cookies = r2.cookies;
console.log("After GET / #2: cookies=", cookies.slice(0, 200));

// Step 3: GET post page with all cookies
console.log("\n=== GET /p/Dcv9Bz7MSYQ ===");
const r3 = await fetchWithCookieTracking("https://www.instagram.com/p/Dcv9Bz7MSYQ", { ...headers, Cookie: cookies });
console.log("  status:", r3.status, "size:", r3.text.length);
console.log("  cookies after:", r3.cookies.slice(0, 200));

const ogV = r3.text.match(/<meta[^>]*property=["']og:video["'][^>]*content=["'](https?:[^"']+)["']/i);
const ogI = r3.text.match(/<meta[^>]*property=["']og:image["'][^>]*content=["'](https?:[^"']+)["']/i);
const ogT = r3.text.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
console.log("  og:video:", ogV?.[1]?.slice(0, 200) || "NONE");
console.log("  og:image:", ogI?.[1]?.slice(0, 200) || "NONE");
console.log("  og:title:", ogT?.[1]?.slice(0, 100) || "NONE");

const mp4 = [...r3.text.matchAll(/https?:[^"'\\\s]+\.mp4[^"'\\\s]*/g)];
console.log("  mp4 count:", mp4.length);
mp4.slice(0, 3).forEach((m, i) => console.log("  mp4 " + (i+1) + ":", m[0].slice(0, 200)));

const playback = [...r3.text.matchAll(/playback_url[^,}\s"]*["']?(https?:[^"'\s,}]+)/g)];
console.log("  playback_url count:", playback.length);
playback.slice(0, 3).forEach((m, i) => console.log("  " + (i+1) + ".", (m[1] || m[0]).slice(0, 200)));

const sjsBlocks = [...r3.text.matchAll(/<script[^>]*data-sjs[^>]*>([\s\S]+?)<\/script>/g)];
console.log("  data-sjs blocks:", sjsBlocks.length);
for (const block of sjsBlocks.slice(0, 5)) {
  const m = block[1].match(/"video_url"\s*:\s*"(https?:[^"]+)"/);
  if (m) console.log("  VIDEO_URL in sjs:", m[1].slice(0, 200));
  const m2 = block[1].match(/"playback_url"\s*:\s*"(https?:[^"]+)"/);
  if (m2) console.log("  playback_url in sjs:", m2[1].slice(0, 200));
}