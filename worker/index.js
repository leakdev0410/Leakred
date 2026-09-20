// Leakred — Cloudflare Worker proxy + yt-dlp-style IG/FB extractor.
// Port các strategies của yt-dlp/yt-dlp sang JavaScript, hoạt động kèm
// session cookies do user cung cấp qua header.
//
// Routes:
//   GET  /                          → health/info
//   GET  /api/instagram?url=...     → trả JSON media cho link Instagram
//   GET  /api/facebook?url=...      → trả JSON media cho link Facebook
//   GET  /api/tiktok?url=...        → passthrough đến tikwm.com (đã ổn định)
//
// Headers frontend gửi:
//   X-IG-Cookie: sessionid=...    (Instagram session cookies)
//   X-FB-Cookie: c_user=...; xs=...; (Facebook session cookies)
//
// Khi không có cookie → worker thử strategies anonymous (OG scrape + GraphQL no-auth).
// Khi có cookie → worker thử yt-dlp-style GraphQL + data-sjs parsing.
//
// Triển khai: xem README.md

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CHROME_UA = DEFAULT_UA;

// yt-dlp's encoding table for shortcode <-> pk conversion
const _ENCODING_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function shortcodeToId(shortcode) {
  let acc = 0;
  for (let i = 0; i < shortcode.length; i++) {
    const idx = _ENCODING_CHARS.indexOf(shortcode[i]);
    if (idx === -1) continue;
    acc = acc * 64 + idx;
  }
  return String(acc);
}

function extractShortcode(url) {
  // /p/SHORTCODE/, /reel/SHORTCODE/, /reels/SHORTCODE/, /tv/SHORTCODE/, /stories/USER/SHORTCODE/
  const m = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function extractFbVideoId(url) {
  // fb.watch/ID, facebook.com/watch/?v=ID, facebook.com/USER/videos/ID, facebook.com/reel/ID
  let m = url.match(/fb\.watch\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  m = url.match(/[?&]v=(\d+)/);
  if (m) return m[1];
  m = url.match(/facebook\.com\/[^/]+\/videos\/(\d+)/);
  if (m) return m[1];
  m = url.match(/facebook\.com\/reel\/(\d+)/);
  if (m) return m[1];
  return null;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-IG-Cookie, X-FB-Cookie",
  "Access-Control-Max-Age": "86400",
};

// =========================================================================
// Shared utilities
// =========================================================================

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function browserHeaders(cookie) {
  return {
    "User-Agent": CHROME_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    ...(cookie ? { "Cookie": cookie } : {}),
  };
}

function graphqlHeaders(cookie, lsd, friendlyName) {
  return {
    "User-Agent": CHROME_UA,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.5",
    "Content-Type": "application/x-www-form-urlencoded",
    "X-IG-App-ID": "936619743392459",
    "X-ASBD-ID": "359341",
    "X-IG-WWW-Claim": "0",
    "Origin": "https://www.instagram.com",
    "Referer": "https://www.instagram.com/",
    "X-FB-Friendly-Name": friendlyName,
    "X-FB-LSD": lsd,
    "X-Requested-With": "XMLHttpRequest",
    "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    ...(cookie ? { "Cookie": cookie } : {}),
  };
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// =========================================================================
// Instagram — yt-dlp strategy port
// =========================================================================

// Lấy LSD token từ main page. Cache trong instance để dùng lại.
let _lsdTokenCache = { value: null, ts: 0 };

async function getLsdToken(cookie, TIMEOUT) {
  if (_lsdTokenCache.value && Date.now() - _lsdTokenCache.ts < 600_000) {
    return _lsdTokenCache.value;
  }
  const res = await fetchWithTimeout("https://www.instagram.com/", {
    headers: browserHeaders(cookie),
    redirect: "follow",
  }, TIMEOUT);
  if (!res.ok) return null;
  const html = await res.text();
  // Pattern 1: ["LSD",[],{"token":"..."}]
  let m = html.match(/\["LSD",\[\],\{"token":"([^"]+)"/);
  if (m) {
    _lsdTokenCache = { value: m[1], ts: Date.now() };
    return m[1];
  }
  // Pattern 2: __eqmc JSON
  const eqmc = html.match(/<script[^>]*id="__eqmc"[^>]*>([\s\S]+?)<\/script>/);
  if (eqmc) {
    try {
      const j = JSON.parse(eqmc[1]);
      if (j.l) {
        _lsdTokenCache = { value: j.l, ts: Date.now() };
        return j.l;
      }
    } catch (_) {}
  }
  return null;
}

// Parse response từ PolarisLoggedOutDesktopWWWPostRootContentQuery
function extractFromGqlResponse(j) {
  const polaris = j?.data?.xig_polaris_media;
  if (!polaris) return null;
  const product = polaris.if_not_gated_logged_out;
  if (!product) return null;

  const formats = (product.video_versions || []).map((v) => ({
    url: v.url, width: v.width, height: v.height,
    type: v.type, id: v.id,
  }));
  const images = (product.image_versions2?.candidates || [])
    .sort((a, b) => (b.width || 0) - (a.width || 0))
    .map((c) => c.url)
    .filter(Boolean);

  // carousel / sidecar
  const isCarousel = Array.isArray(polaris.carousel_media) && polaris.carousel_media.length > 0;
  if (isCarousel) {
    const items = polaris.carousel_media.map((m) => {
      const vids = m.video_versions || [];
      const best = vids.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
      const imgs = (m.image_versions2?.candidates || [])
        .sort((a, b) => (b.width || 0) - (a.width || 0));
      return best ? { kind: "video", url: best.url } : { kind: "image", url: imgs[0]?.url };
    }).filter((it) => it.url);
    return {
      type: items.length > 1 ? "carousel" : items[0].kind,
      url: items[0]?.url,
      items: items.length > 1 ? items : undefined,
      title: product.title || polaris.caption?.text || "",
      author: product.user?.username || "",
      authorAvatar: product.user?.profile_pic_url || "",
      thumbnail: images[0] || "",
      duration: product.video_duration || null,
    };
  }

  if (formats.length === 0 && images.length === 0) return null;

  return {
    type: formats.length ? "video" : "image",
    url: formats[0]?.url || images[0],
    title: product.title || polaris.caption?.text || "",
    author: product.user?.username || "",
    authorAvatar: product.user?.profile_pic_url || "",
    thumbnail: images[0] || "",
    duration: product.video_duration || null,
  };
}

// Strategy 1 (logged-in / cookie present): GraphQL query với cookie
async function igStrategyGraphql(cookie, shortcode, TIMEOUT) {
  const lsd = await getLsdToken(cookie, TIMEOUT);
  if (!lsd) return { ok: false, reason: "no-lsd-token" };

  const mediaId = shortcodeToId(shortcode);
  const body = new URLSearchParams({
    lsd,
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: "PolarisLoggedOutDesktopWWWPostRootContentQuery",
    server_timestamps: "true",
    variables: JSON.stringify({ media_id: mediaId }),
    doc_id: "27130156389949648",
  });

  const res = await fetchWithTimeout("https://www.instagram.com/api/graphql", {
    method: "POST",
    headers: graphqlHeaders(cookie, lsd, "PolarisLoggedOutDesktopWWWPostRootContentQuery"),
    body: body.toString(),
  }, TIMEOUT);

  if (!res.ok) return { ok: false, reason: "graphql-http-" + res.status };
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch (_) { return { ok: false, reason: "graphql-bad-json" }; }
  const data = extractFromGqlResponse(j);
  if (!data) return { ok: false, reason: "graphql-empty" };
  return { ok: true, source: "graphql", ...data };
}

// Strategy 2 (cookie present or not): page parse từ <script data-sjs>
async function igStrategyPageParse(cookie, shortcode, TIMEOUT) {
  const res = await fetchWithTimeout(
    `https://www.instagram.com/p/${shortcode}/`,
    { headers: browserHeaders(cookie), redirect: "manual" },
    TIMEOUT,
  );
  if (res.status === 301 || res.status === 302) return { ok: false, reason: "redirect" };
  if (!res.ok) return { ok: false, reason: "page-http-" + res.status };
  const html = await res.text();

  // yt-dlp's SJS regex: <script data-sjs>({.+?})</script>
  const sjsRe = /<script\b[^>]+\bdata-sjs>(\{.+?\})<\/script>/g;
  for (const m of html.matchAll(sjsRe)) {
    try {
      const j = JSON.parse(m[1]);
      const data = extractFromGqlResponse({ data: { xig_polaris_media: j?.__bbox?.result?.data?.xig_polaris_media || j?.data?.xig_polaris_media } });
      if (data) return { ok: true, source: "data-sjs", ...data };
      // Try direct structure
      const polaris = j?.require?.[0]?.[3]?.[0]?.[3]?.xig_polaris_media;
      if (polaris) {
        const direct = extractFromGqlResponse({ data: { xig_polaris_media: polaris } });
        if (direct) return { ok: true, source: "data-sjs", ...direct };
      }
    } catch (_) {}
  }

  // Fallback: og:video / og:image (ít khi có nhưng rẻ)
  const ogV = html.match(/<meta[^>]*property=["']og:video["'][^>]*content=["'](https?:[^"']+)["']/i);
  const ogI = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["'](https?:[^"']+)["']/i);
  const ogT = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  if (ogV) {
    return { ok: true, source: "og",
      type: "video", url: ogV[1],
      title: ogT?.[1] || "", thumbnail: ogI?.[1] || "",
    };
  }
  if (ogI) {
    return { ok: true, source: "og",
      type: "image", url: ogI[1],
      thumbnail: ogI[1], title: ogT?.[1] || "",
    };
  }
  return { ok: false, reason: "no-data-in-page" };
}

async function handleInstagram(url, cookie, TIMEOUT) {
  const shortcode = extractShortcode(url);
  if (!shortcode) return { ok: false, error: "URL Instagram không hợp lệ" };

  // Strategy 1: GraphQL (ưu tiên khi có cookie)
  if (cookie) {
    const r = await igStrategyGraphql(cookie, shortcode, TIMEOUT);
    if (r.ok) return r;
  }
  // Strategy 2: page parse (luôn thử)
  const p = await igStrategyPageParse(cookie, shortcode, TIMEOUT);
  if (p.ok) return p;
  return {
    ok: false,
    error: cookie
      ? "Không lấy được media IG (cookie có thể đã hết hạn hoặc post này không truy cập được)"
      : "Không lấy được media IG. Thử thêm sessionid cookie (xem hướng dẫn trong README).",
  };
}

// =========================================================================
// Facebook — yt-dlp strategy port
// =========================================================================

async function fbStrategyPageParse(cookie, rawUrl, TIMEOUT) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(rawUrl, {
      headers: {
        "User-Agent": CHROME_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
        ...(cookie ? { "Cookie": cookie } : {}),
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(id);
    if (!res.ok) return { ok: false, reason: "fb-http-" + res.status };
    const html = await res.text();

    // og:video (cheap, may work for some public posts)
    const ogV = html.match(/<meta[^>]*property=["']og:video["'][^>]*content=["'](https?:[^"']+)["']/i);
    const ogI = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["'](https?:[^"']+)["']/i);
    const ogT = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);

    // Search for FB-internal video JSON: __bbox, video dash URL, etc.
    // Pattern 1: playable_url_quality_hd or playable_url
    const playable = html.match(/"playable_url(?:_quality_hd)?"\s*:\s*"(https?:[^"\\]+\.mp4[^"\\]*)"/);
    if (playable) {
      return { ok: true, source: "playable_url",
        type: "video", url: playable[1],
        title: ogT?.[1] || "", thumbnail: ogI?.[1] || "",
      };
    }

    // Pattern 2: browser_native_*.mp4 URL
    const browserNative = html.match(/(https?:\/\/[^"'\\\s]+browser_native_[^"'\\\s]+\.mp4)/);
    if (browserNative) {
      return { ok: true, source: "browser_native",
        type: "video", url: browserNative[1],
        title: ogT?.[1] || "", thumbnail: ogI?.[1] || "",
      };
    }

    // Pattern 3: og:video (public)
    if (ogV) {
      return { ok: true, source: "og",
        type: "video", url: ogV[1],
        title: ogT?.[1] || "", thumbnail: ogI?.[1] || "",
      };
    }
    if (ogI) {
      return { ok: true, source: "og",
        type: "image", url: ogI[1], thumbnail: ogI[1],
        title: ogT?.[1] || "",
      };
    }
    return { ok: false, reason: "no-data-in-page" };
  } catch (e) {
    clearTimeout(id);
    return { ok: false, reason: e.name === "AbortError" ? "timeout" : e.message };
  }
}

async function handleFacebook(url, cookie, TIMEOUT) {
  const id = extractFbVideoId(url);
  if (!id) return { ok: false, error: "URL Facebook không hợp lệ" };
  // Normalize URL for fetch
  const normalized = url.includes("facebook.com") || url.includes("fb.watch") ? url : `https://www.facebook.com/watch/?v=${id}`;
  const r = await fbStrategyPageParse(cookie, normalized, TIMEOUT);
  if (r.ok) return r;
  return {
    ok: false,
    error: cookie
      ? "Không lấy được video FB (cookie có thể hết hạn hoặc post này không truy cập được)"
      : "Không lấy được video FB. Thử thêm c_user cookie (xem README).",
  };
}

// =========================================================================
// TikTok — passthrough TikWM
// =========================================================================

async function handleTikTok(url) {
  const api = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`;
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(api, { signal: ctrl.signal });
    clearTimeout(id);
    if (!res.ok) return { ok: false, error: "TikTok API HTTP " + res.status };
    const j = await res.json();
    if (!j || j.code !== 0 || !j.data) return { ok: false, error: "TikTok API returned no data" };
    const d = j.data;
    if (Array.isArray(d.images) && d.images.length) {
      return {
        ok: true, platform: "tiktok", source: "tikwm", type: "carousel",
        items: d.images.map((u) => ({ kind: "image", url: u })),
        title: d.title || "", thumbnail: d.cover || "",
        author: d.author?.nickname || d.author?.unique_id || "",
        authorAvatar: d.author?.avatar || "",
      };
    }
    const video = d.hdplay || d.play || d.wmplay;
    if (!video) return { ok: false, error: "TikTok: no video URL" };
    return {
      ok: true, platform: "tiktok", source: "tikwm", type: "video", url: video,
      title: d.title || "", thumbnail: d.cover || "",
      duration: d.duration || null,
      author: d.author?.nickname || d.author?.unique_id || "",
      authorAvatar: d.author?.avatar || "",
    };
  } catch (e) {
    clearTimeout(id);
    return { ok: false, error: "TikTok fetch failed: " + e.message };
  }
}

// =========================================================================
// Routes
// =========================================================================

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const u = new URL(request.url);
    const p = u.pathname;
    if (p === "/" || p === "/health") {
      return json({
        ok: true, name: "leakred-downloader",
        routes: ["/api/instagram?url=", "/api/facebook?url=", "/api/tiktok?url="],
        timestamp: new Date().toISOString(),
      });
    }
    if (env.WORKER_TOKEN) {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== "Bearer " + env.WORKER_TOKEN) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }
    }
    const target = u.searchParams.get("url");
    if (!target) return json({ ok: false, error: "missing ?url=" }, 400);

    const TIMEOUT = Number(env.STRATEGY_TIMEOUT_MS || 6000);
    const igCookie = request.headers.get("X-IG-Cookie") || "";
    const fbCookie = request.headers.get("X-FB-Cookie") || "";

    try {
      if (p === "/api/instagram") {
        const result = await handleInstagram(target, igCookie, TIMEOUT);
        if (result.ok) result.platform = "instagram";
        const status = result.ok ? 200 : 502;
        return json(result, status);
      }
      if (p === "/api/facebook") {
        const result = await handleFacebook(target, fbCookie, TIMEOUT);
        if (result.ok) result.platform = "facebook";
        const status = result.ok ? 200 : 502;
        return json(result, status);
      }
      if (p === "/api/tiktok") {
        const result = await handleTikTok(target);
        const status = result.ok ? 200 : 502;
        return json(result, status);
      }
      return json({ ok: false, error: "not found: " + p }, 404);
    } catch (e) {
      return json({ ok: false, error: "worker error: " + e.message }, 500);
    }
  },
};