(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const urlInput = $("#urlInput");
  const form = $("#downloadForm");
  const downloadBtn = $("#downloadBtn");
  const pasteBtn = $("#pasteBtn");
  const resultEl = $("#result");
  const toastEl = $("#toast");
  const badges = document.querySelectorAll(".platform-badge");

  const CORS_PROXIES = [
    (u) => "https://corsproxy.io/?" + encodeURIComponent(u),
    (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
    (u) => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u),
  ];
  const FETCH_TIMEOUT_MS = 18000;

  const PLATFORM_PATTERNS = {
    tiktok: /(?:^|\.)tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com/i,
    instagram: /(?:^|\.)instagram\.com|ddinstagram\.com/i,
    facebook: /(?:^|\.)facebook\.com|fb\.watch|fb\.com/i,
  };

  function detectPlatform(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl.trim());
    } catch {
      return null;
    }
    const host = url.hostname;
    for (const [name, re] of Object.entries(PLATFORM_PATTERNS)) {
      if (re.test(host)) return name;
    }
    return null;
  }

  function updateBadges(platform) {
    badges.forEach((b) => {
      b.classList.toggle("active", b.dataset.platform === platform);
    });
  }

  function showToast(msg, type = "info", ms = 3500) {
    toastEl.textContent = msg;
    toastEl.className = "toast show " + type;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      toastEl.className = "toast";
    }, ms);
  }

  async function fetchWithTimeout(url, opts = {}) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      return res;
    } finally {
      clearTimeout(id);
    }
  }

  async function fetchJson(url, opts) {
    const res = await fetchWithTimeout(url, opts);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  async function fetchText(url, opts) {
    const res = await fetchWithTimeout(url, opts);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.text();
  }

  async function fetchViaProxies(targetUrl, { method = "GET", body = null, headers = {}, parseJson = false } = {}) {
    let lastErr;
    for (const buildProxy of CORS_PROXIES) {
      try {
        const url = buildProxy(targetUrl);
        const opts = { method, headers };
        if (body != null) opts.body = body;
        const res = await fetchWithTimeout(url, opts);
        if (!res.ok) { lastErr = new Error("HTTP " + res.status); continue; }
        const text = await res.text();
        if (!text) { lastErr = new Error("Empty body"); continue; }
        if (parseJson) {
          try { return JSON.parse(text); } catch { lastErr = new Error("Bad JSON"); continue; }
        }
        return text;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("Tất cả CORS proxy đều lỗi.");
  }

  // TikTok (giữ nguyên)
  async function fetchTikTok(url) {
    const api = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`;
    const json = await fetchJson(api);
    if (!json || json.code !== 0 || !json.data) {
      throw new Error("Không lấy được dữ liệu từ TikTok.");
    }
    const d = json.data;
    if (Array.isArray(d.images) && d.images.length) {
      return {
        type: "carousel",
        items: d.images.map((u) => ({ kind: "image", url: u })),
        title: d.title || "",
        author: d.author?.nickname || d.author?.unique_id || "",
        authorAvatar: d.author?.avatar || "",
        thumbnail: d.cover || "",
        platform: "tiktok",
      };
    }
    const video = d.hdplay || d.play || d.wmplay;
    if (!video) throw new Error("Không tìm thấy URL video TikTok.");
    return {
      type: "video",
      url: video,
      title: d.title || "",
      author: d.author?.nickname || d.author?.unique_id || "",
      authorAvatar: d.author?.avatar || "",
      thumbnail: d.cover || "",
      duration: d.duration || null,
      platform: "tiktok",
    };
  }

  // Harvest media (giữ nguyên)
  function harvestMediaFromHtml(html) {
    const found = { videos: [], images: [] };
    const seen = new Set();
    const push = (arr, u) => { if (u && !seen.has(u)) { seen.add(u); arr.push(u); } };

    const hrefRe = /href=["']([^"']+)["']/gi;
    let m;
    while ((m = hrefRe.exec(html)) !== null) {
      const raw = decodeHtml(unescapeJson(m[1]));
      if (/^https?:\/\//i.test(raw) && /(\.mp4|\.jpg|\.jpeg|\.png|\.webp)(\?|$)/i.test(raw)) {
        if (/\.mp4(\?|$)/i.test(raw)) push(found.videos, raw);
        else push(found.images, raw);
      }
      if (/^https?:\/\//i.test(raw) && /(cdninstagram|fbcdn|scontent)/i.test(raw)) {
        if (/\.mp4/i.test(raw)) push(found.videos, raw);
        else if (/\.(jpg|jpeg|png|webp)/i.test(raw)) push(found.images, raw);
      }
    }

    const mp4Re = /(https?:\\?\/\\?\/[^"'\\s\\]+\\.mp4[^"'\\s\\]*)/gi;
    while ((m = mp4Re.exec(html)) !== null) push(found.videos, unescapeJson(m[1]));

    const ogV = html.match(/property=["']og:video["']\s+content=["']([^"']+)["']/i);
    if (ogV) push(found.videos, decodeHtml(ogV[1]));
    const ogI = html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i);
    if (ogI) push(found.images, decodeHtml(ogI[1]));

    return found;
  }

  function pickTitleFromHtml(html) {
    const og = html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i);
    if (og) return decodeHtml(og[1]);
    const t = html.match(/<title>([^<]+)<\/title>/i);
    return t ? decodeHtml(t[1]) : "";
  }

  // Snapsave decryption (giữ nguyên)
  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function decodeSnapApp(args) {
    const [h, , n, t, e] = args;
    const tNum = Number(t);
    const eNum = Number(e);
    const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/";
    const toNum = (d, base) => d.split("").reverse().reduce((a, b, c) => {
      const idx = alphabet.indexOf(b);
      return idx !== -1 && idx < base ? a + idx * Math.pow(base, c) : a;
    }, 0);

    let result = "";
    const delim = n[eNum];
    for (let i = 0; i < h.length;) {
      let s = "";
      while (i < h.length && h[i] !== delim) { s += h[i]; i++; }
      i++;
      for (let j = 0; j < n.length; j++) {
        s = s.replace(new RegExp(escapeRe(n[j]), "g"), String(j));
      }
      result += String.fromCharCode(toNum(s, eNum) - tNum);
    }
    try {
      const bytes = new Uint8Array([...result].map((c) => c.charCodeAt(0)));
      return new TextDecoder("utf-8").decode(bytes);
    } catch { return result; }
  }
  function extractSnapArgs(data) {
    const tail = data.split("decodeURIComponent(escape(r))}(\")[1];
    if (!tail) throw new Error("snapsave: không tìm thấy payload");
    return tail.split("))")[0].split(",").map((v) => v.replace(/"/g, "").trim());
  }
  function decryptSnapSave(data) {
    const err = data.split('document.querySelector("#alert").innerHTML = "')[1]?.split('";')[0]?.trim();
    if (err) throw new Error(err);
    const decoded = decodeSnapApp(extractSnapArgs(data));
    const partA = decoded.split('getElementById("download-section").innerHTML = "')[1];
    if (!partA) throw new Error("snapsave: response không như mong đợi");
    return partA.split('"; document.getElementById("inputData").remove(); ')[0].replace(/\\(\\)?/g, "");
  }
  async function callSnapsave(targetUrl) {
    const endpoint = "https://snapsave.app/action.php?lang=en";
    const body = "url=" + encodeURIComponent(targetUrl);
    const text = await fetchViaProxies(endpoint, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Accept": "*/*",
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    return decryptSnapSave(text);
  }

  function parseSnapsaveHtml(html, platform) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const desc = doc.querySelector("span.video-des")?.textContent.trim() || doc.querySelector(".video-title, .videotikmate-middle p")?.textContent.trim() || "";
    const figureThumb = doc.querySelector("article.media figure img")?.getAttribute("src") || "";

    const table = doc.querySelector("table.table");
    if (table) {
      const videos = [...table.querySelectorAll("tbody tr")].map((tr) => {
        const tds = tr.querySelectorAll("td");
        let url = tds[2]?.querySelector("a")?.getAttribute("href") || "";
        return { url };
      }).filter((v) => v.url && v.url !== "#");
      if (videos.length) {
        return { type: "video", url: videos[0].url, title: desc, thumbnail: figureThumb, platform };
      }
    }

    const firstA = doc.querySelector("a[href^='http']");
    if (firstA) {
      const txt = (firstA.textContent || "").trim();
      const kind = /photo|ảnh/i.test(txt) ? "image" : "video";
      return { type: kind, url: firstA.getAttribute("href"), title: desc, thumbnail: figureThumb, platform };
    }
    return null;
  }

  // Instagram Updated
  async function fetchInstagram(url) {
    try {
      const html = await callSnapsave(url);
      const data = parseSnapsaveHtml(html, "instagram");
      if (data) return data;
    } catch (_) {}

    const fallbacks = [
      { endpoint: "https://v3.saveig.app/api/ajaxSearch", body: `q=${encodeURIComponent(url)}&t=media&lang=vi` },
      { endpoint: "https://snapinsta.app/api/ajaxSearch", body: `q=${encodeURIComponent(url)}&t=media&lang=en` },
      { endpoint: "https://en.savefrom.net/api/convert", body: `url=${encodeURIComponent(url)}` },
    ];

    for (const fb of fallbacks) {
      try {
        const text = await fetchViaProxies(fb.endpoint, {
          method: "POST",
          body: fb.body,
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "Accept": "*/*" },
        });
        let html = text;
        try { const j = JSON.parse(text); html = j.data || j.html || text; } catch (_) {}
        const { videos, images } = harvestMediaFromHtml(html);
        if (videos.length) return { type: "video", url: videos[0], title: pickTitleFromHtml(html), thumbnail: images[0] || "", platform: "instagram" };
        if (images.length) return { type: "image", url: images[0], thumbnail: images[0], title: pickTitleFromHtml(html), platform: "instagram" };
      } catch (_) {}
    }

    throw new Error("Không tải được Instagram. Thử link khác hoặc chờ vài phút.");
  }

  // Facebook (giữ nguyên)
  async function fetchFacebook(url) {
    try {
      const html = await callSnapsave(url);
      const data = parseSnapsaveHtml(html, "facebook");
      if (data) return data;
    } catch (_) {}

    throw new Error("Không tải được Facebook.");
  }

  function decodeHtml(s) {
    const el = document.createElement("textarea");
    el.innerHTML = s;
    return el.value;
  }
  function unescapeJson(s) {
    return s.replace(/\\u0025/g, "%").replace(/\\\//g, "/").replace(/\\u0026/g, "&");
  }

  const HANDLERS = {
    tiktok: fetchTikTok,
    instagram: fetchInstagram,
    facebook: fetchFacebook,
  };

  async function triggerDownload(mediaUrl, filename) {
    try {
      const res = await fetchWithTimeout(mediaUrl);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      showToast("Đã bắt đầu tải xuống.", "success");
    } catch (e) {
      window.open(mediaUrl, "_blank");
      showToast("Mở tab mới để tải.", "info", 5000);
    }
  }

  function inferExt(url, fallback) {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/\.(mp4|jpg|jpeg|png|webp|mov|gif)(?:$|\?)/i);
      if (m) return m[1].toLowerCase();
    } catch (_) {}
    return fallback;
  }

  function buildFilename(platform, kind, idx) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const suffix = idx != null ? `-${idx + 1}` : "";
    const ext = kind === "image" ? "jpg" : "mp4";
    return `leakred-${platform}-${stamp}${suffix}.${ext}`;
  }

  function renderResult(data) {
    // (Giữ nguyên từ code gốc của mày - paste phần renderResult, buildMeta từ file cũ vào đây)
    resultEl.classList.remove("hidden");
    // ... code render đầy đủ
    console.log("Result:", data); // tạm
  }

  function buildMeta(data) {
    // tương tự
  }

  // Main
  urlInput.addEventListener("input", () => {
    const p = detectPlatform(urlInput.value);
    updateBadges(p);
  });

  pasteBtn.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      urlInput.value = text.trim();
      updateBadges(detectPlatform(urlInput.value));
    } catch {}
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return showToast("Nhập link!", "error");

    const platform = detectPlatform(url);
    if (!platform) return showToast("Link không hỗ trợ.", "error");

    downloadBtn.disabled = true;
    try {
      const data = await HANDLERS[platform](url);
      renderResult(data);
      showToast("Thành công!", "success");
    } catch (err) {
      showToast(err.message, "error", 5000);
    } finally {
      downloadBtn.disabled = false;
    }
  });
})();
