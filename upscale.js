(() => {
  "use strict";

  // ---------- Upscale ảnh bằng model AI thật (ESRGAN-slim qua TensorFlow.js) ----------
  // tf.js + upscaler.js + trọng số model được tự host trong ./vendor/upscaler
  // (không gọi CDN lúc runtime).
  const MODEL_DEFS = {
    2: {
      path: "vendor/upscaler/models/x2/model.json",
      scale: 2,
      modelType: "layers",
      inputRange: [0, 1],
      outputRange: [0, 1],
    },
    4: {
      path: "vendor/upscaler/models/x4/model.json",
      scale: 4,
      modelType: "layers",
      inputRange: [0, 1],
      outputRange: [0, 1],
    },
  };

  const panel = document.getElementById("tab-upscale");
  const dropzone = document.getElementById("upcDropzone");
  const fileInput = document.getElementById("upcFileInput");
  const scaleSelect = document.getElementById("upcScale");
  const loadingEl = document.getElementById("upcLoading");
  const loadingText = document.getElementById("upcLoadingText");
  const progressEl = document.getElementById("upcProgress");
  const doneEl = document.getElementById("upcDone");
  const errorEl = document.getElementById("upcError");
  const fillEl = document.getElementById("upcFill");
  const percentEl = document.getElementById("upcPercent");
  const phaseEl = document.getElementById("upcPhase");
  const filenameEl = document.getElementById("upcFilename");
  const originalImg = document.getElementById("upcOriginalImg");
  const resultImg = document.getElementById("upcResultImg");
  const downloadBtn = document.getElementById("upcDownload");
  const doneFile = document.getElementById("upcDoneFile");
  const errorMsg = document.getElementById("upcErrorMsg");
  const resetBtn = document.getElementById("upcReset");
  const retryBtn = document.getElementById("upcRetry");

  if (!dropzone) return; // safety: if tab not rendered

  const upscalerCache = {};
  const upscalerLoading = {};
  let currentOriginalUrl = null;
  let currentResultUrl = null;

  async function ensureUpscaler(scale) {
    if (upscalerCache[scale]) return upscalerCache[scale];
    if (upscalerLoading[scale]) return upscalerLoading[scale];

    upscalerLoading[scale] = (async () => {
      showStatus(loadingEl);
      loadingText.textContent = `Đang tải model AI ${scale}x (lần đầu)…`;

      if (typeof tf === "undefined" || typeof Upscaler === "undefined") {
        throw new Error("Không tải được vendor/upscaler (tf.js / upscaler.js).");
      }

      const inst = new Upscaler({ model: MODEL_DEFS[scale] });
      await inst.ready;
      upscalerCache[scale] = inst;
      return inst;
    })();

    try {
      const inst = await upscalerLoading[scale];
      return inst;
    } finally {
      upscalerLoading[scale] = null;
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
    if (currentOriginalUrl) {
      URL.revokeObjectURL(currentOriginalUrl);
      currentOriginalUrl = null;
    }
    if (currentResultUrl) {
      URL.revokeObjectURL(currentResultUrl);
      currentResultUrl = null;
    }
    showStatus(null);
    fileInput.value = "";
    fillEl.style.width = "0%";
    originalImg.src = "";
    resultImg.src = "";
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
    if (panel && !panel.classList.contains("hidden")) e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    if (panel && !panel.classList.contains("hidden")) e.preventDefault();
  });

  resetBtn.addEventListener("click", reset);
  retryBtn.addEventListener("click", reset);

  async function handleFile(file) {
    if (!file.type || !file.type.startsWith("image/")) {
      showError("File không phải ảnh hợp lệ.");
      return;
    }

    const scale = parseInt(scaleSelect.value, 10) || 4;

    filenameEl.textContent = file.name;
    showStatus(progressEl);
    setProgress(0, "Đang đọc ảnh…");

    if (currentOriginalUrl) URL.revokeObjectURL(currentOriginalUrl);
    const objectUrl = URL.createObjectURL(file);
    currentOriginalUrl = objectUrl;

    const img = new Image();
    img.src = objectUrl;
    try {
      await img.decode();
    } catch (err) {
      showError("Không đọc được ảnh: " + (err.message || err));
      return;
    }
    originalImg.src = objectUrl;

    let upscaler;
    try {
      upscaler = await ensureUpscaler(scale);
    } catch (err) {
      console.error(err);
      showError("Không tải được model AI: " + (err.message || err));
      return;
    }

    showStatus(progressEl);
    setProgress(0, "Đang xử lý…");

    try {
      const resultDataUrl = await upscaler.upscale(img, {
        patchSize: 128,
        padding: 8,
        progress: (rate) => setProgress(Math.max(0, Math.min(99.9, rate * 100)), "Đang xử lý…"),
      });

      setProgress(100, "Đang tạo file…");
      resultImg.src = resultDataUrl;

      const blob = await (await fetch(resultDataUrl)).blob();
      if (currentResultUrl) URL.revokeObjectURL(currentResultUrl);
      const blobUrl = URL.createObjectURL(blob);
      currentResultUrl = blobUrl;

      const baseName = file.name.replace(/\.[^.]+$/, "");
      const downloadName = `${baseName}_upscaled_${scale}x.png`;
      downloadBtn.href = blobUrl;
      downloadBtn.download = downloadName;
      doneFile.textContent = downloadName;

      showStatus(doneEl);
    } catch (err) {
      console.error(err);
      showError(err.message || String(err));
    }
  }
})();
