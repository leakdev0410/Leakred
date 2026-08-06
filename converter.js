(() => {
  "use strict";

  // ---------- Tab switcher ----------
  const tabs = document.querySelectorAll(".tab");
  const panels = {
    download: document.getElementById("tab-download"),
    convert: document.getElementById("tab-convert"),
    upscale: document.getElementById("tab-upscale"),
  };

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      tabs.forEach((t) => {
        const active = t === tab;
        t.classList.toggle("active", active);
        t.setAttribute("aria-selected", active ? "true" : "false");
      });
      Object.entries(panels).forEach(([k, el]) => {
        if (!el) return;
        el.classList.toggle("hidden", k !== name);
      });
    });
  });

  // ---------- Converter (ffmpeg.wasm, single-thread) ----------
  // @ffmpeg/ffmpeg + util self-host trong ./vendor (same-origin để Worker chạy được).
  // Chỉ ffmpeg-core (~30MB wasm) load từ CDN qua toBlobURL.
  const CORE_VER = "0.12.10";
  const CORE_CDN_BASES = [
    "https://cdn.jsdelivr.net/npm",
    "https://unpkg.com",
  ];

  const dropzone = document.getElementById("convDropzone");
  const fileInput = document.getElementById("convFileInput");
  const loadingEl = document.getElementById("convLoading");
  const loadingText = document.getElementById("convLoadingText");
  const progressEl = document.getElementById("convProgress");
  const doneEl = document.getElementById("convDone");
  const errorEl = document.getElementById("convError");
  const fillEl = document.getElementById("convFill");
  const percentEl = document.getElementById("convPercent");
  const phaseEl = document.getElementById("convPhase");
  const filenameEl = document.getElementById("convFilename");
  const downloadBtn = document.getElementById("convDownload");
  const doneFile = document.getElementById("convDoneFile");
  const errorMsg = document.getElementById("convErrorMsg");
  const resetBtn = document.getElementById("convReset");
  const retryBtn = document.getElementById("convRetry");

  if (!dropzone) return; // safety: if tab not rendered

  let ffmpeg = null;
  let ffmpegLoading = null;
  let currentBlobUrl = null;
  let toBlobURL = null;
  let fetchFile = null;

  async function ensureFFmpeg() {
    if (ffmpeg) return ffmpeg;
    if (ffmpegLoading) return ffmpegLoading;

    ffmpegLoading = (async () => {
      showStatus(loadingEl);
      loadingText.textContent = "Đang tải ffmpeg.wasm…";

      let FFmpeg;
      try {
        const [ffmpegMod, utilMod] = await Promise.all([
          import("./vendor/ffmpeg/index.js"),
          import("./vendor/util/index.js"),
        ]);
        FFmpeg = ffmpegMod.FFmpeg;
        toBlobURL = utilMod.toBlobURL;
        fetchFile = utilMod.fetchFile;
        if (!FFmpeg || !toBlobURL || !fetchFile) {
          throw new Error("vendor/ffmpeg hoặc vendor/util thiếu exports.");
        }
      } catch (err) {
        throw new Error("Không load được vendor module: " + (err.message || err));
      }

      loadingText.textContent = "Đang tải core (~30MB)…";

      let coreErr;
      for (const base of CORE_CDN_BASES) {
        // ESM core vì FFmpeg worker là type:"module" — không có importScripts,
        // phải fallback await import(_coreURL).default. UMD build không có
        // export default nên fail; ESM build kết thúc bằng `export default createFFmpegCore`.
        const coreBase = `${base}/@ffmpeg/core@${CORE_VER}/dist/esm`;
        try {
          const ff = new FFmpeg();
          ff.on("log", ({ message }) => console.log("[ffmpeg]", message));
          await ff.load({
            coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`, "text/javascript"),
            wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, "application/wasm"),
          });
          ffmpeg = ff;
          return ff;
        } catch (err) {
          console.warn("[converter] core load failed from", coreBase, err);
          coreErr = err;
        }
      }
      throw coreErr || new Error("Không tải được ffmpeg-core từ mọi CDN.");
    })();

    try {
      const ff = await ffmpegLoading;
      return ff;
    } catch (err) {
      ffmpegLoading = null;
      throw err;
    }
  }

  function showStatus(el) {
    [loadingEl, progressEl, doneEl, errorEl].forEach((e) => e.classList.add("hidden"));
    if (el) el.classList.remove("hidden");
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    showStatus(errorEl);
  }

  function setProgress(pct, phase) {
    fillEl.style.width = pct + "%";
    percentEl.textContent = pct.toFixed(1) + "%";
    if (phase) phaseEl.textContent = phase;
  }

  function reset() {
    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = null;
    }
    showStatus(null);
    fileInput.value = "";
    fillEl.style.width = "0%";
  }

  // Drag-drop + file picker
  dropzone.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
  });

  ["dragenter", "dragover"].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove("dragover");
    });
  });

  dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  });

  // Avoid browser opening dropped file outside the zone
  window.addEventListener("dragover", (e) => {
    if (panels.convert && !panels.convert.classList.contains("hidden")) e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    if (panels.convert && !panels.convert.classList.contains("hidden")) e.preventDefault();
  });

  resetBtn.addEventListener("click", reset);
  retryBtn.addEventListener("click", reset);

  async function handleFile(file) {
    filenameEl.textContent = file.name;
    showStatus(progressEl);
    setProgress(0, "Đang đọc file…");

    const ext = (file.name.match(/\.[^.]+$/) || [".mp4"])[0].toLowerCase();
    const inputName = "input" + ext;
    const outputName = "output.mp4";

    const onProgress = ({ progress }) => {
      const pct = Math.max(0, Math.min(99.9, progress * 100));
      setProgress(pct, "Đang convert…");
    };

    let ff;
    try {
      ff = await ensureFFmpeg();
    } catch (err) {
      console.error(err);
      showError("Không tải được ffmpeg.wasm: " + (err.message || err));
      return;
    }

    showStatus(progressEl);
    setProgress(0, "Đang ghi file vào bộ nhớ…");

    try {
      ff.on("progress", onProgress);

      await ff.writeFile(inputName, await fetchFile(file));

      setProgress(0, "Đang convert…");

      const ret = await ff.exec([
        "-i", inputName,
        "-vf", "scale=1920:1080,setsar=1:1",
        "-c:v", "libx264",
        "-crf", "23",
        "-preset", "ultrafast",
        "-c:a", "aac",
        "-b:a", "160k",
        outputName,
      ]);

      if (ret !== 0) throw new Error("ffmpeg convert thất bại (xem console).");

      setProgress(100, "Đang tạo file…");

      const data = await ff.readFile(outputName);
      const blob = new Blob([data.buffer], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      currentBlobUrl = url;

      const baseName = file.name.replace(/\.[^.]+$/, "");
      const downloadName = `${baseName}_16x9.mp4`;
      downloadBtn.href = url;
      downloadBtn.download = downloadName;
      doneFile.textContent = downloadName;

      try { await ff.deleteFile(inputName); } catch {}
      try { await ff.deleteFile(outputName); } catch {}

      showStatus(doneEl);
    } catch (err) {
      console.error(err);
      showError(err.message || String(err));
    } finally {
      if (ff && ff.off) ff.off("progress", onProgress);
    }
  }
})();
