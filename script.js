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

  // ---------- TikTok ----------
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

  // ---------- Shared IG / FB helpers (no-backend public CORS APIs) ----------
  function parseSnapToken(proxyUrl) {
    try {
      const token = new URL(proxyUrl).searchParams.get("token");
      if (!token) return null;
      const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(atob(b64));
    } catch {
      return null;
    }
  }

  function inferKindFromProxyUrl(proxyUrl, fallbackType) {
    const p = parseSnapToken(proxyUrl);
    const target = `${p?.filename || ""} ${p?.url || ""} ${proxyUrl}`.toLowerCase();
    if (/\.(mp4|mov|webm)(\?|$|\s)/.test(target) || /\/v\/t16\//.test(target)) return "video";
    if (/\.(jpg|jpeg|png|webp)(\?|$|\s)/.test(target)) return "image";
    return fallbackType === "image" ? "image" : "video";
  }

  async function fetchSiputzxShared(endpoint, url, platform) {
    const api = `https://api.siputzx.my.id/api/d/${endpoint}?url=${encodeURIComponent(url)}`;
    const json = await fetchJson(api);
    if (!json || !json.status || !json.data) throw new Error("Empty response");
    const raw = endpoint === "savefrom" ? json.data?.[0]?.data : json.data;
    const entries = (Array.isArray(raw) ? raw : [raw]).filter((e) => e && Array.isArray(e.url) && e.url.length);
    if (!entries.length) throw new Error("No media entries");
    const first = entries[0];
    const title = first.meta?.title || "";
    const author = first.meta?.username || "";
    const thumbnail = first.thumb || "";
    const items = entries.map((e) => {
      const uObj = e.url[0];
      const ext = (uObj.ext || uObj.type || "").toLowerCase();
      const kind = /^(jpg|jpeg|png|webp)$/.test(ext) ? "image" : "video";
      return { kind, url: uObj.url };
    }).filter((it) => it.url);
    if (!items.length) throw new Error("No media URL");
    if (items.length === 1) {
      return { type: items[0].kind, url: items[0].url, title, author, thumbnail, platform };
    }
    return { type: "carousel", items, title, author, thumbnail, platform };
  }

  // ---------- Instagram ----------
  async function fetchInstagram(url) {
    // 1. jerrycoder.oggyapi.workers.dev (~1s, native CORS + dl.snapcdn.app/saveinsta CORS CDN)
    try {
      const j = await fetchJson(`https://jerrycoder.oggyapi.workers.dev/insta?url=${encodeURIComponent(url)}`);
      const d = j?.status === "success" ? j.data : null;
      if (d) {
        const mediaKeys = Object.keys(d)
          .filter((k) => /^media_url_\d+$/.test(k) && d[k])
          .sort((a, b) => Number(a.split("_").pop()) - Number(b.split("_").pop()));
        if (mediaKeys.length > 1) {
          const items = mediaKeys.map((k) => ({
            kind: inferKindFromProxyUrl(d[k], d.type),
            url: d[k],
          }));
          return { type: "carousel", items, title: d.title || "", thumbnail: d.thumbnail || "", platform: "instagram" };
        }
        if (d.url) {
          const kind = inferKindFromProxyUrl(d.url, d.type);
          return { type: kind, url: d.url, title: d.title || "", thumbnail: d.thumbnail || (kind === "image" ? d.url : ""), platform: "instagram" };
        }
      }
    } catch (_) { /* fallback */ }

    // 2. api.siputzx.my.id (ummy & savefrom — native CORS + media.ummy.net / sf-converter CORS CDN)
    for (const ep of ["ummy", "savefrom"]) {
      try {
        return await fetchSiputzxShared(ep, url, "instagram");
      } catch (_) { /* fallback */ }
    }

    // 3. backend1.tioo.eu.org/igdl (client-side direct, native CORS + d.rapidcdn.app CORS CDN)
    try {
      const j = await fetchJson(`https://backend1.tioo.eu.org/igdl?url=${encodeURIComponent(url)}`);
      const rawItems = Array.isArray(j) ? j : (j?.result || []);
      const seen = new Set();
      const items = [];
      for (const it of rawItems) {
        if (!it || !it.url) continue;
        const p = parseSnapToken(it.url);
        const key = p?.filename || p?.url?.split("?")[0] || it.url;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ kind: inferKindFromProxyUrl(it.url, "video"), url: it.url, thumbnail: it.thumbnail || "" });
      }
      if (items.length === 1) {
        return { type: items[0].kind, url: items[0].url, thumbnail: items[0].thumbnail, title: "", platform: "instagram" };
      }
      if (items.length > 1) {
        return { type: "carousel", items: items.map(({ kind, url: u }) => ({ kind, url: u })), thumbnail: items[0].thumbnail, title: "", platform: "instagram" };
      }
    } catch (_) { /* fallback */ }

    throw new Error("Không tải được nội dung Instagram (có thể là tài khoản riêng tư hoặc API tạm lỗi).");
  }

  // ---------- Facebook ----------
  async function fetchFacebook(url) {
    // 1. api.siputzx.my.id/api/d/facebook (native CORS, SnapCDN HD/SD)
    try {
      const j = await fetchJson(`https://api.siputzx.my.id/api/d/facebook?url=${encodeURIComponent(url)}`);
      const d = j?.status && j.data;
      const dl = Array.isArray(d?.downloads) && d.downloads.find((x) => x && x.url);
      if (dl) {
        const mediaUrl = dl.url.replace("dl.snapcdn.app/get?token=", "dl.snapcdn.app/saveinsta?token=");
        return {
          type: "video",
          url: mediaUrl,
          title: d.title && d.title !== "Facebook Video" ? d.title : "",
          thumbnail: d.thumbnail || "",
          platform: "facebook",
        };
      }
    } catch (_) { /* fallback */ }

    // 2. api.siputzx.my.id (ummy & savefrom — native CORS + fbcdn HD/SD)
    for (const ep of ["ummy", "savefrom"]) {
      try {
        return await fetchSiputzxShared(ep, url, "facebook");
      } catch (_) { /* fallback */ }
    }

    // 3. backend1.tioo.eu.org/fbdown (client-side direct, native CORS)
    try {
      const j = await fetchJson(`https://backend1.tioo.eu.org/fbdown?url=${encodeURIComponent(url)}`);
      const videoUrl = j?.HD || j?.Normal_video || j?.hd || j?.normal_video || j?.result?.[0]?.url;
      if (videoUrl) {
        return { type: "video", url: videoUrl, title: j.title || "", thumbnail: j.thumbnail || "", platform: "facebook" };
      }
    } catch (_) { /* fallback */ }

    throw new Error("Không tải được video Facebook (có thể là nội dung riêng tư hoặc API tạm lỗi).");
  }

  const HANDLERS = {
    tiktok: fetchTikTok,
    instagram: fetchInstagram,
    facebook: fetchFacebook,
  };

  // ---------- Download helper ----------
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
          src: data.url, controls: true, playsInline: true,
          poster: data.thumbnail || "",
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
