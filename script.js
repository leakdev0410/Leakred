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

  // Instagram cần CORS proxy. corsproxy.io đã ngừng hỗ trợ dùng không cần API key;
  // cors.eu.org hỗ trợ cả GET lẫn POST, allorigins / codetabs chỉ dùng được cho GET.
  const CORS_PROXIES = [
    (u) => "https://cors.eu.org/" + u,
    (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
    (u) => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u),
  ];
  const FETCH_TIMEOUT_MS = 18000;
  const PROXY_FETCH_TIMEOUT_MS = 8000;
  const EMBED_FETCH_TIMEOUT_MS = 15000;
  const fetchViaProxies = window.LeakredProxyFetch.createProxyFetcher({
    proxyBuilders: CORS_PROXIES,
    timeoutMs: PROXY_FETCH_TIMEOUT_MS,
  });

  const PLATFORM_PATTERNS = {
    tiktok: /(?:^|\.)tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com/i,
    instagram: /(?:^|\.)instagram\.com$|(?:^|\.)instagr\.am$/i,
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

  // ---------- snapsave decryption (IG) ----------
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
      validate: (t) => t.includes("decodeURIComponent(escape(r))") || t.includes('querySelector("#alert")'),
    });
    return decryptSnapSave(text);
  }

  // snapsave: mỗi div.download-items là một ảnh / video của bài viết.
  function parseSnapsaveHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const items = [...doc.querySelectorAll("div.download-items")].map((el) => {
      const thumb = el.querySelector(".download-items__thumb img")?.getAttribute("src") || "";
      const btn = el.querySelector(".download-items__btn");
      const href = btn?.querySelector("a")?.getAttribute("href") || "";
      const spanText = btn?.querySelector("span")?.textContent.trim() || "";
      const isPhoto = /photo|ảnh/i.test(spanText);
      return { kind: isPhoto ? "image" : "video", url: isPhoto ? thumb : href, thumbnail: thumb };
    }).filter((it) => it.url);
    return buildMediaResult(items, { title: "", platform: "instagram" });
  }

  // ---------- Instagram ----------
  // Tham khảo https://github.com/coflyn/scrapr (lib/instagram/indown + direct), MIT.
  function cleanInstagramUrl(url) {
    const m = url.trim().match(/https?:\/\/[^\s]+/i);
    const raw = m ? m[0] : url.trim();
    return raw.split(/[?#]/)[0];
  }

  function instagramShortcode(url) {
    const m = url.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
    return m ? m[1] : null;
  }

  // Link dl.snapcdn.app / rapidcdn chứa JWT có trường url (link gốc cdninstagram).
  function snapTokenTarget(href) {
    const m = /token=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/.exec(href || "");
    if (!m) return "";
    try {
      const b64 = m[2].replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4)));
      return String(payload.url || "") + " " + String(payload.filename || "");
    } catch (_) {
      return "";
    }
  }

  function buildMediaResult(items, extra) {
    if (!items.length) return null;
    if (items.length === 1) {
      const it = items[0];
      return { type: it.kind, url: it.url, thumbnail: it.thumbnail || "", ...extra };
    }
    return { type: "carousel", items, thumbnail: items[0].thumbnail || "", ...extra };
  }

  // indown.net: trả JSON { status, data: "<ul class=download-box>..." } chứa link snapcdn.
  async function fetchInstagramIndown(cleanUrl) {
    const body = new URLSearchParams({ q: cleanUrl, vt: "reel", t: "media", lang: "en", v: "v2" }).toString();
    const json = await fetchViaProxies("https://indown.net/api/ajaxSearch", {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Accept": "*/*",
        "X-Requested-With": "XMLHttpRequest",
      },
      parseJson: true,
      // Proxy chỉ hỗ trợ GET sẽ làm mất body → indown trả lỗi không kèm `url`; bỏ qua để chờ proxy khác.
      validate: (j) => Boolean(j && (j.data || j.url)),
    });
    if (!json || json.status !== "ok" || !json.data) {
      const mess = String(json?.mess || "").replace(/<[^>]+>/g, "").replace(/^Error:\s*/i, "").trim();
      throw new Error(mess || "indown: không có dữ liệu");
    }

    const doc = new DOMParser().parseFromString(json.data, "text/html");
    const items = [];
    const seen = new Set();
    doc.querySelectorAll(".download-items").forEach((el) => {
      const thumbnail = el.querySelector(".download-items__thumb img, img")?.getAttribute("src") || "";
      const links = [...el.querySelectorAll("a[href^='http']")].map((a) => {
        const href = a.getAttribute("href");
        const label = `${a.getAttribute("title") || ""} ${a.textContent || ""}`;
        let kind = null;
        if (/video|mp4|reel/i.test(label)) kind = "video";
        else if (/photo|image|ảnh/i.test(label)) kind = "image";
        if (!kind) {
          const target = snapTokenTarget(href);
          if (/\.(mp4|mov|webm)(\?|\s|$)/i.test(target)) kind = "video";
          else if (/\.(jpe?g|png|webp|heic)(\?|\s|$)/i.test(target)) kind = "image";
        }
        return { href, kind: kind || (/\.mp4(\?|$)/i.test(href) ? "video" : "image") };
      }).filter((l) => l.href && !seen.has(l.href));
      if (!links.length) return;
      // Với video, nút "Download Image" chỉ là ảnh bìa → ưu tiên link video.
      const pick = links.find((l) => l.kind === "video") || links[0];
      seen.add(pick.href);
      items.push({ kind: pick.kind, url: pick.href, thumbnail });
    });

    const data = buildMediaResult(items, { title: "", platform: "instagram" });
    if (!data) throw new Error("indown: không tìm thấy link tải");
    return data;
  }

  // Đọc chuỗi JSON literal bắt đầu tại vị trí dấu " (xử lý escape đúng chuẩn).
  function readJsonStringLiteral(text, quoteIdx) {
    for (let i = quoteIdx + 1; i < text.length; i++) {
      if (text[i] === "\\") { i++; continue; }
      if (text[i] === '"') return JSON.parse(text.slice(quoteIdx, i + 1));
    }
    return null;
  }

  // Trang embed chính thức: https://www.instagram.com/p/<code>/embed/captioned/
  // Ảnh / carousel luôn có link gốc; video chỉ có video_url khi IG cho phép.
  async function fetchInstagramEmbed(shortcode) {
    const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
    // IG chỉ trả dữ liệu cho UA kiểu Safari; proxy chuyển tiếp UA khác sẽ nhận trang trống,
    // nên phải kiểm tra nội dung. allorigins dùng UA riêng nhưng chậm → nới thời gian chờ.
    const html = await fetchViaProxies(embedUrl, {
      validate: (text) => text.includes('"contextJSON":"') || text.includes("EmbeddedMediaImage"),
      timeoutMs: EMBED_FETCH_TIMEOUT_MS,
    });

    const key = '"contextJSON":"';
    const idx = html.indexOf(key);
    let media = null;
    if (idx !== -1) {
      const ctxText = readJsonStringLiteral(html, idx + key.length - 1);
      media = ctxText ? JSON.parse(ctxText)?.gql_data?.shortcode_media : null;
    }

    if (!media) {
      // Bài ảnh đơn: IG không gửi contextJSON, chỉ có <img class="EmbeddedMediaImage">.
      // Video / carousel cũng có thẻ này (ảnh bìa) nên phải loại trừ chúng.
      if (!html.includes('"isSidecar":false') || /PlayButton/.test(html)) {
        throw new Error("embed: không có dữ liệu media");
      }
      const doc = new DOMParser().parseFromString(html, "text/html");
      const src = doc.querySelector("img.EmbeddedMediaImage")?.getAttribute("src");
      if (!src) throw new Error("embed: không có dữ liệu media");
      return { type: "image", url: src, thumbnail: src, title: "", platform: "instagram" };
    }

    const nodes = media.edge_sidecar_to_children?.edges?.length
      ? media.edge_sidecar_to_children.edges.map((e) => e.node)
      : [media];
    if (nodes.some((n) => n.is_video && !n.video_url)) {
      throw new Error("embed: video bị ẩn link");
    }
    const items = nodes.map((n) => ({
      kind: n.is_video ? "video" : "image",
      url: n.is_video ? n.video_url : n.display_url,
      thumbnail: n.display_url || "",
    })).filter((it) => it.url);

    const data = buildMediaResult(items, {
      title: media.edge_media_to_caption?.edges?.[0]?.node?.text || "",
      author: media.owner?.username || "",
      authorAvatar: media.owner?.profile_pic_url || "",
      platform: "instagram",
    });
    if (!data) throw new Error("embed: không tìm thấy media");
    return data;
  }


  async function fetchInstagram(url) {
    const cleanUrl = cleanInstagramUrl(url);
    const shortcode = instagramShortcode(cleanUrl);
    let reason = "";

    try {
      return await fetchInstagramIndown(cleanUrl);
    } catch (e) {
      if (e && e.message && !/^indown:|CORS proxies/.test(e.message)) {
        reason = /private/i.test(e.message) ? "bài viết riêng tư hoặc không tồn tại" : e.message;
      }
    }

    try {
      const data = parseSnapsaveHtml(await callSnapsave(cleanUrl));
      if (data) return data;
    } catch (_) { /* fallback */ }

    if (shortcode) {
      try {
        return await fetchInstagramEmbed(shortcode);
      } catch (_) { /* fallback */ }
    }

    throw new Error(reason
      ? `Không tải được nội dung Instagram: ${reason}`
      : "Không tải được nội dung Instagram (có thể là tài khoản riêng tư hoặc API tạm lỗi).");
  }

  const HANDLERS = {
    tiktok: fetchTikTok,
    instagram: fetchInstagram,
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
          ? Object.assign(document.createElement("video"), {
              src: item.url, controls: true, playsInline: true, poster: item.thumbnail || "",
            })
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
      return showToast("Link không hỗ trợ. Chỉ nhận link TikTok / Instagram.", "error");
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