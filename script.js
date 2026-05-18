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

  // Khi chạy trong Tauri (Android/desktop): bypass CORS bằng cách gọi Rust trực tiếp.
  const IS_TAURI = typeof window !== "undefined" && !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
  const tauriInvoke = IS_TAURI
    ? (window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke)
    : null;

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

  // Thử lần lượt các CORS proxy. Trả text (hoặc JSON nếu parseJson=true).
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

  // ---------- TikTok ----------
  async function fetchTikTok(url) {
    if (IS_TAURI) return await tauriInvoke("fetch_tiktok", { url });
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

  // Lọc URL media từ một đoạn HTML/JSON (link mp4 hoặc ảnh CDN của IG/FB).
  function harvestMediaFromHtml(html) {
    const found = { videos: [], images: [] };
    const seen = new Set();
    const push = (arr, u) => { if (u && !seen.has(u)) { seen.add(u); arr.push(u); } };

    // Bóc link "href=" trong các nút download (snapinsta / saveig / snapsave).
    const hrefRe = /href=["']([^"']+)["']/gi;
    let m;
    while ((m = hrefRe.exec(html)) !== null) {
      const raw = decodeHtml(unescapeJson(m[1]));
      if (/^https?:\/\//i.test(raw) && /(\.mp4|\.jpg|\.jpeg|\.png|\.webp)(\?|$)/i.test(raw)) {
        if (/\.mp4(\?|$)/i.test(raw)) push(found.videos, raw);
        else push(found.images, raw);
      }
      // CDN của Instagram / Facebook (scontent / cdninstagram / fbcdn)
      if (/^https?:\/\//i.test(raw) && /(cdninstagram|fbcdn|scontent)/i.test(raw)) {
        if (/\.mp4/i.test(raw)) push(found.videos, raw);
        else if (/\.(jpg|jpeg|png|webp)/i.test(raw)) push(found.images, raw);
      }
    }

    // Bóc các url MP4 trần trong JSON-trong-HTML (snapsave trả về JSON.html chứa <a>).
    const mp4Re = /(https?:\\?\/\\?\/[^"'\s\\]+\.mp4[^"'\s\\]*)/gi;
    while ((m = mp4Re.exec(html)) !== null) push(found.videos, unescapeJson(m[1]));

    // og:video / og:image cuối cùng.
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

  // ---------- snapsave decryption (FB + IG) ----------
  // Port từ https://github.com/ahmedrangel/snapsave-media-downloader
  // snapsave.app trả về JS đã obfuscate; cần decode rồi parse HTML bên trong.
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
    const tail = data.split("decodeURIComponent(escape(r))}(")[1];
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
    const desc = doc.querySelector("span.video-des")?.textContent.trim()
              || doc.querySelector(".video-title, .videotikmate-middle p")?.textContent.trim()
              || "";
    const figureThumb = doc.querySelector("article.media figure img")?.getAttribute("src") || "";

    // Pattern A: FB nhiều resolution (table.table)
    const table = doc.querySelector("table.table");
    if (table) {
      const videos = [...table.querySelectorAll("tbody tr")].map((tr) => {
        const tds = tr.querySelectorAll("td");
        const resolution = (tds[0]?.textContent || "").trim();
        let url = tds[2]?.querySelector("a")?.getAttribute("href")
              || tds[2]?.querySelector("button")?.getAttribute("onclick") || "";
        const m = /get_progressApi\('(.*?)'\)/.exec(url);
        if (m) url = "https://snapsave.app" + m[1];
        return { url, resolution };
      }).filter((v) => v.url && v.url !== "#");
      if (videos.length) {
        return {
          type: "video",
          url: videos[0].url,
          title: desc,
          thumbnail: figureThumb,
          platform,
        };
      }
    }

    // Pattern B: IG carousel / post (div.download-items)
    const items = [...doc.querySelectorAll("div.download-items")].map((el) => {
      const thumb = el.querySelector(".download-items__thumb img")?.getAttribute("src") || "";
      const btn = el.querySelector(".download-items__btn");
      const href = btn?.querySelector("a")?.getAttribute("href") || "";
      const spanText = btn?.querySelector("span")?.textContent.trim() || "";
      const isPhoto = /photo|ảnh/i.test(spanText);
      return { kind: isPhoto ? "image" : "video", url: isPhoto ? thumb : href, thumbnail: thumb };
    }).filter((it) => it.url);
    if (items.length === 1) {
      const it = items[0];
      return {
        type: it.kind === "image" ? "image" : "video",
        url: it.url,
        thumbnail: it.thumbnail,
        title: desc,
        platform,
      };
    }
    if (items.length > 1) {
      return {
        type: "carousel",
        items: items.map((it) => ({ kind: it.kind, url: it.url })),
        thumbnail: items[0].thumbnail,
        title: desc,
        platform,
      };
    }

    // Pattern C: div.card (FB single)
    const cards = [...doc.querySelectorAll("div.card")];
    if (cards.length) {
      const cardItems = cards.map((el) => {
        const a = el.querySelector(".card-body a, a");
        const url = a?.getAttribute("href") || "";
        const txt = (a?.textContent || "").trim();
        return { kind: /photo|ảnh/i.test(txt) ? "image" : "video", url };
      }).filter((it) => it.url && it.url !== "#");
      if (cardItems.length === 1) {
        return { type: cardItems[0].kind, url: cardItems[0].url, title: desc, thumbnail: figureThumb, platform };
      }
      if (cardItems.length > 1) {
        return { type: "carousel", items: cardItems, title: desc, thumbnail: figureThumb, platform };
      }
    }

    // Pattern D: chỉ có 1 link <a>
    const firstA = doc.querySelector("a[href^='http']");
    if (firstA) {
      const txt = (firstA.textContent || "").trim();
      const kind = /photo|ảnh/i.test(txt) ? "image" : "video";
      return { type: kind, url: firstA.getAttribute("href"), title: desc, thumbnail: figureThumb, platform };
    }
    return null;
  }

  // ---------- Instagram ----------
  async function fetchInstagram(url) {
    if (IS_TAURI) return await tauriInvoke("fetch_instagram", { url });
    try {
      const html = await callSnapsave(url);
      const data = parseSnapsaveHtml(html, "instagram");
      if (data) return data;
    } catch (_) { /* fallback */ }

    // Fallback: saveig / snapinsta (HTML response, harvest raw href)
    const fallback = [
      { endpoint: "https://v3.saveig.app/api/ajaxSearch", body: `q=${encodeURIComponent(url)}&t=media&lang=vi` },
      { endpoint: "https://snapinsta.app/api/ajaxSearch", body: `q=${encodeURIComponent(url)}&t=media&lang=en` },
    ];
    for (const t of fallback) {
      try {
        const text = await fetchViaProxies(t.endpoint, {
          method: "POST",
          body: t.body,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Accept": "*/*",
            "X-Requested-With": "XMLHttpRequest",
          },
        });
        let html = text;
        try { const j = JSON.parse(text); html = j.data || j.html || text; } catch (_) {}
        const { videos, images } = harvestMediaFromHtml(html);
        if (videos.length) return { type: "video", url: videos[0], title: pickTitleFromHtml(html), thumbnail: images[0] || "", platform: "instagram" };
        if (images.length === 1) return { type: "image", url: images[0], thumbnail: images[0], title: pickTitleFromHtml(html), platform: "instagram" };
        if (images.length > 1) return { type: "carousel", items: images.map((u) => ({ kind: "image", url: u })), thumbnail: images[0], title: pickTitleFromHtml(html), platform: "instagram" };
      } catch (_) { /* tiếp tục */ }
    }

    throw new Error("Không tải được nội dung Instagram (có thể là tài khoản riêng tư hoặc API tạm lỗi).");
  }

  // ---------- Facebook ----------
  async function fetchFacebook(url) {
    if (IS_TAURI) return await tauriInvoke("fetch_facebook", { url });
    try {
      const html = await callSnapsave(url);
      const data = parseSnapsaveHtml(html, "facebook");
      if (data) return data;
    } catch (_) { /* fallback */ }

    // Fallback: getmyfb / fdownloader (sister sites, snap-style)
    const fallback = [
      { endpoint: "https://getmyfb.com/api/ajaxSearch", body: `q=${encodeURIComponent(url)}&t=media&lang=vi` },
      { endpoint: "https://fdownloader.net/api/ajaxSearch", body: `q=${encodeURIComponent(url)}&t=media&lang=vi` },
    ];
    for (const t of fallback) {
      try {
        const text = await fetchViaProxies(t.endpoint, {
          method: "POST",
          body: t.body,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Accept": "*/*",
            "X-Requested-With": "XMLHttpRequest",
          },
        });
        let html = text;
        try { const j = JSON.parse(text); html = j.data || j.html || text; } catch (_) {}
        const { videos, images } = harvestMediaFromHtml(html);
        if (videos.length) return { type: "video", url: videos[0], title: pickTitleFromHtml(html), thumbnail: images[0] || "", platform: "facebook" };
        if (images.length) return { type: "image", url: images[0], thumbnail: images[0], title: pickTitleFromHtml(html), platform: "facebook" };
      } catch (_) { /* tiếp tục */ }
    }

    throw new Error("Không tải được video Facebook (có thể là nội dung riêng tư hoặc API tạm lỗi).");
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

  // ---------- Download helper ----------
  async function triggerDownload(mediaUrl, filename) {
    if (IS_TAURI) {
      try {
        const path = await tauriInvoke("download_media", { url: mediaUrl, filename });
        showToast("Đã lưu: " + path, "success", 4000);
      } catch (e) {
        showToast("Lỗi tải: " + (e?.message || e), "error", 5000);
      }
      return;
    }
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
      // Fallback: mở tab mới
      window.open(mediaUrl, "_blank", "noopener");
      showToast("Trình duyệt chặn tải trực tiếp — đã mở tab mới, bấm chuột phải > Lưu video / ảnh.", "info", 5000);
    }
  }

  function inferExt(url, fallback) {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/\.(mp4|jpg|jpeg|png|webp|mov|gif)(?:$|\?)/i);
      if (m) return m[1].toLowerCase();
    } catch (_) { /* ignore */ }
    return fallback;
  }

  function buildFilename(platform, kind, idx) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const suffix = idx != null ? `-${idx + 1}` : "";
    const ext = kind === "image" ? "jpg" : "mp4";
    return `leakred-${platform}-${stamp}${suffix}.${ext}`;
  }

  // ---------- Renderers ----------
  function renderResult(data) {
    resultEl.classList.remove("hidden");
    resultEl.innerHTML = "";

    if (data.type === "carousel") {
      const grid = document.createElement("div");
      grid.className = "carousel-grid";
      data.items.forEach((item, i) => {
        const cell = document.createElement("div");
        cell.className = "carousel-item";
        const node = item.kind === "video"
          ? Object.assign(document.createElement("video"), { src: item.url, controls: true, playsInline: true })
          : Object.assign(document.createElement("img"), { src: item.url, alt: "" });
        cell.appendChild(node);
        const a = document.createElement("a");
        a.className = "item-dl";
        a.textContent = "Tải";
        a.href = "#";
        const ext = inferExt(item.url, item.kind === "image" ? "jpg" : "mp4");
        const fname = `leakred-${data.platform}-${i + 1}.${ext}`;
        a.addEventListener("click", (e) => {
          e.preventDefault();
          triggerDownload(item.url, fname);
        });
        cell.appendChild(a);
        grid.appendChild(cell);
      });
      resultEl.appendChild(grid);

      const body = document.createElement("div");
      body.className = "result-body";
      body.appendChild(buildMeta(data));
      const actions = document.createElement("div");
      actions.className = "result-actions";
      const downloadAll = document.createElement("button");
      downloadAll.className = "btn btn-primary";
      downloadAll.innerHTML = `<span class="btn-label">Tải tất cả (${data.items.length})</span>`;
      downloadAll.addEventListener("click", async () => {
        for (let i = 0; i < data.items.length; i++) {
          const it = data.items[i];
          const ext = inferExt(it.url, it.kind === "image" ? "jpg" : "mp4");
          await triggerDownload(it.url, `leakred-${data.platform}-${i + 1}.${ext}`);
          await new Promise((r) => setTimeout(r, 400));
        }
      });
      actions.appendChild(downloadAll);
      body.appendChild(actions);
      resultEl.appendChild(body);
      return;
    }

    const isVideo = data.type === "video";
    const media = isVideo
      ? Object.assign(document.createElement("video"), {
          src: data.url, controls: true, playsInline: true, poster: data.thumbnail || "",
        })
      : Object.assign(document.createElement("img"), { src: data.url, alt: data.title || "" });
    media.className = "result-media";
    resultEl.appendChild(media);

    const body = document.createElement("div");
    body.className = "result-body";
    body.appendChild(buildMeta(data));

    const actions = document.createElement("div");
    actions.className = "result-actions";

    const dl = document.createElement("button");
    dl.className = "btn btn-primary";
    dl.innerHTML = `<span class="btn-label">${isVideo ? "Tải video" : "Tải ảnh"}</span>`;
    const ext = inferExt(data.url, isVideo ? "mp4" : "jpg");
    const fname = buildFilename(data.platform, isVideo ? "video" : "image").replace(/\.(mp4|jpg)$/, "." + ext);
    dl.addEventListener("click", () => triggerDownload(data.url, fname));
    actions.appendChild(dl);

    if (data.thumbnail && isVideo) {
      const thumbBtn = document.createElement("button");
      thumbBtn.className = "btn btn-ghost";
      thumbBtn.innerHTML = `<span class="btn-label">Tải ảnh bìa</span>`;
      thumbBtn.addEventListener("click", () => {
        const tExt = inferExt(data.thumbnail, "jpg");
        triggerDownload(data.thumbnail, buildFilename(data.platform, "image").replace(/\.jpg$/, "." + tExt));
      });
      actions.appendChild(thumbBtn);
    }

    body.appendChild(actions);
    resultEl.appendChild(body);
  }

  function buildMeta(data) {
    const meta = document.createElement("div");
    meta.className = "result-meta";
    if (data.author) {
      const a = document.createElement("div");
      a.className = "result-author";
      if (data.authorAvatar) {
        const img = document.createElement("img");
        img.src = data.authorAvatar;
        img.alt = "";
        a.appendChild(img);
      }
      const span = document.createElement("span");
      span.textContent = "@" + data.author;
      a.appendChild(span);
      meta.appendChild(a);
    }
    if (data.title) {
      const t = document.createElement("div");
      t.className = "result-title";
      t.textContent = data.title;
      meta.appendChild(t);
    }
    return meta;
  }

  // ---------- Main flow ----------
  urlInput.addEventListener("input", () => {
    const p = detectPlatform(urlInput.value);
    updateBadges(p);
  });

  pasteBtn.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return showToast("Clipboard trống.", "error");
      urlInput.value = text.trim();
      updateBadges(detectPlatform(urlInput.value));
      urlInput.focus();
    } catch {
      showToast("Trình duyệt chặn truy cập clipboard. Hãy dán thủ công (Ctrl+V).", "error");
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return showToast("Hãy nhập link cần tải.", "error");

    const platform = detectPlatform(url);
    if (!platform) {
      return showToast("Link không hỗ trợ. Chỉ nhận TikTok / Instagram / Facebook.", "error");
    }

    downloadBtn.disabled = true;
    downloadBtn.classList.add("loading");
    resultEl.classList.add("hidden");

    try {
      const data = await HANDLERS[platform](url);
      renderResult(data);
      showToast("Đã sẵn sàng — bấm Tải để lưu về máy.", "success");
      resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      const msg = (err && err.message) ? err.message : "Có lỗi xảy ra.";
      showToast(msg, "error", 5000);
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.classList.remove("loading");
    }
  });
})();
