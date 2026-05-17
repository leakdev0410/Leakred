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

  const CORS_PROXY = "https://corsproxy.io/?";
  const FETCH_TIMEOUT_MS = 15000;

  const PLATFORM_PATTERNS = {
    tiktok: /(?:^|\.)tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com/i,
    instagram: /(?:^|\.)instagram\.com/i,
    facebook: /(?:^|\.)facebook\.com|fb\.watch|(?:^|\.)fb\.com/i,
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

  // ---------- Instagram ----------
  async function fetchInstagram(url) {
    // Cố gắng dùng tikwm-style endpoint trước
    try {
      const api = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
      const json = await fetchJson(api);
      if (json && json.code === 0 && json.data) {
        const d = json.data;
        if (Array.isArray(d.images) && d.images.length) {
          return {
            type: "carousel",
            items: d.images.map((u) => ({ kind: "image", url: u })),
            title: d.title || "",
            author: d.author?.nickname || "",
            thumbnail: d.cover || "",
            platform: "instagram",
          };
        }
        const v = d.play || d.hdplay || d.wmplay;
        if (v) {
          return {
            type: "video",
            url: v,
            title: d.title || "",
            author: d.author?.nickname || "",
            thumbnail: d.cover || "",
            platform: "instagram",
          };
        }
      }
    } catch (_) {
      // sang fallback
    }

    // Fallback: dùng CORS proxy + scrape og-tags từ trang IG
    try {
      const proxied = CORS_PROXY + encodeURIComponent(url);
      const html = await fetchText(proxied);
      const ogVideo = html.match(/property=["']og:video["']\s+content=["']([^"']+)["']/i)
        || html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:video["']/i);
      const ogImage = html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i)
        || html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i);
      const ogTitle = html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i);

      if (ogVideo) {
        return {
          type: "video",
          url: decodeHtml(ogVideo[1]),
          thumbnail: ogImage ? decodeHtml(ogImage[1]) : "",
          title: ogTitle ? decodeHtml(ogTitle[1]) : "",
          platform: "instagram",
        };
      }
      if (ogImage) {
        return {
          type: "image",
          url: decodeHtml(ogImage[1]),
          thumbnail: decodeHtml(ogImage[1]),
          title: ogTitle ? decodeHtml(ogTitle[1]) : "",
          platform: "instagram",
        };
      }
    } catch (_) { /* ignore */ }

    throw new Error("Không tải được nội dung Instagram (có thể là tài khoản riêng tư hoặc API tạm lỗi).");
  }

  // ---------- Facebook ----------
  async function fetchFacebook(url) {
    // Thử tikwm trước (đôi khi hỗ trợ FB)
    try {
      const api = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
      const json = await fetchJson(api);
      if (json && json.code === 0 && json.data) {
        const d = json.data;
        const v = d.hdplay || d.play || d.wmplay;
        if (v) {
          return {
            type: "video",
            url: v,
            title: d.title || "",
            author: d.author?.nickname || "",
            thumbnail: d.cover || "",
            platform: "facebook",
          };
        }
      }
    } catch (_) { /* fallback */ }

    // Fallback: dùng mbasic Facebook qua CORS proxy + regex tìm link MP4
    try {
      const mUrl = url.replace("www.facebook.com", "mbasic.facebook.com")
                      .replace("m.facebook.com", "mbasic.facebook.com")
                      .replace("facebook.com", "mbasic.facebook.com")
                      .replace("fb.watch", "mbasic.facebook.com");
      const proxied = CORS_PROXY + encodeURIComponent(mUrl);
      const html = await fetchText(proxied);

      // Tìm link MP4 (HD trước, SD sau)
      const hd = html.match(/"browser_native_hd_url":"([^"]+)"/);
      const sd = html.match(/"browser_native_sd_url":"([^"]+)"/);
      const generic = html.match(/(https:\/\/[^"\s]+\.mp4[^"\s]*)/);

      const pick = (m) => m ? unescapeJson(m[1]) : null;
      const videoUrl = pick(hd) || pick(sd) || (generic ? generic[1] : null);
      const thumb = html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i);
      const title = html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i);

      if (videoUrl) {
        return {
          type: "video",
          url: videoUrl,
          title: title ? decodeHtml(title[1]) : "",
          thumbnail: thumb ? decodeHtml(thumb[1]) : "",
          platform: "facebook",
        };
      }
    } catch (_) { /* ignore */ }

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
      return showToast("Link không hỗ trợ. Chỉ nhận TikTok, Instagram, Facebook.", "error");
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
