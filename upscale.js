(() => {
  "use strict";

  // Model local tự host; không gọi mạng trong lúc inference.
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

  const OPENROUTER_MODELS = new Set([
    "bytedance-seed/seedream-4.5",
    "bytedance-seed/seedream-5-0-lite",
    "google/gemini-3.1-flash-image",
    "google/gemini-3-pro-image",
    "sourceful/riverflow-v2.5-pro",
  ]);

  const OUTPUT_ASPECT_RATIOS = [
    ["1:1", 1],
    ["2:3", 2 / 3],
    ["3:2", 3 / 2],
    ["3:4", 3 / 4],
    ["4:3", 4 / 3],
    ["4:5", 4 / 5],
    ["5:4", 5 / 4],
    ["9:16", 9 / 16],
    ["16:9", 16 / 9],
    ["21:9", 21 / 9],
  ];

  const panel = document.getElementById("tab-upscale");
  const dropzone = document.getElementById("upcDropzone");
  const dropHint = document.getElementById("upcDropHint");
  const fileInput = document.getElementById("upcFileInput");
  const engineInputs = document.querySelectorAll('input[name="upcEngine"]');
  const engineNote = document.getElementById("upcEngineNote");
  const introEl = document.getElementById("upcIntro");
  const scaleSelect = document.getElementById("upcScale");
  const scaleLabel = document.getElementById("upcScaleLabel");
  const apiSettings = document.getElementById("upcApiSettings");
  const apiModelSelect = document.getElementById("upcApiModel");
  const apiKeyInput = document.getElementById("upcApiKey");
  const toggleKeyBtn = document.getElementById("upcToggleKey");
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
  const resultLabel = document.getElementById("upcResultLabel");
  const successEl = document.getElementById("upcSuccess");
  const downloadBtn = document.getElementById("upcDownload");
  const downloadLabel = document.getElementById("upcDownloadLabel");
  const doneFile = document.getElementById("upcDoneFile");
  const errorMsg = document.getElementById("upcErrorMsg");
  const resetBtn = document.getElementById("upcReset");
  const retryBtn = document.getElementById("upcRetry");

  if (!dropzone) return;

  const upscalerCache = {};
  const upscalerLoading = {};
  let currentOriginalUrl = null;
  let currentResultUrl = null;
  let currentApiController = null;
  let activeJobId = 0;

  function getEngine() {
    return document.querySelector('input[name="upcEngine"]:checked')?.value || "local";
  }

  function updateEngineUi() {
    const isApi = getEngine() === "openrouter";
    apiSettings.hidden = !isApi;
    apiKeyInput.setAttribute("aria-required", isApi ? "true" : "false");
    scaleLabel.textContent = isApi ? "Độ phân giải đầu ra" : "Mức phóng to";
    scaleSelect.options[0].textContent = isApi ? "2K" : "2x";
    scaleSelect.options[1].textContent = isApi ? "4K" : "4x";

    if (isApi) {
      introEl.textContent = "AI Enhance bằng model ảnh trên OpenRouter, phù hợp khi cần phục hồi và tái tạo thêm chi tiết.";
      engineNote.textContent = "Ảnh và prompt sẽ được gửi trực tiếp tới OpenRouter/provider. Trang không lưu API key.";
      dropHint.textContent = "jpg, png, webp… · ảnh sẽ được gửi tới OpenRouter để xử lý";
    } else {
      apiKeyInput.value = "";
      setKeyVisibility(false);
      introEl.textContent = "Upscale riêng tư bằng model local chạy ngay trong trình duyệt. Ảnh không rời khỏi thiết bị.";
      engineNote.textContent = "Local dùng ESRGAN-slim và không tải ảnh lên mạng.";
      dropHint.textContent = "jpg, png, webp… · ảnh càng lớn xử lý càng lâu";
    }
  }

  function setKeyVisibility(visible) {
    apiKeyInput.type = visible ? "text" : "password";
    toggleKeyBtn.textContent = visible ? "Ẩn" : "Hiện";
    toggleKeyBtn.setAttribute("aria-label", visible ? "Ẩn API key" : "Hiện API key");
    toggleKeyBtn.setAttribute("aria-pressed", visible ? "true" : "false");
  }

  async function ensureUpscaler(scale) {
    if (upscalerCache[scale]) return upscalerCache[scale];
    if (upscalerLoading[scale]) return upscalerLoading[scale];

    upscalerLoading[scale] = (async () => {
      if (typeof tf === "undefined" || typeof Upscaler === "undefined") {
        throw new Error("Không tải được vendor/upscaler (tf.js / upscaler.js).");
      }

      const instance = new Upscaler({ model: MODEL_DEFS[scale] });
      await instance.ready;
      upscalerCache[scale] = instance;
      return instance;
    })();

    try {
      return await upscalerLoading[scale];
    } finally {
      upscalerLoading[scale] = null;
    }
  }

  function showStatus(el) {
    [loadingEl, progressEl, doneEl, errorEl].forEach((item) => item.classList.add("hidden"));
    if (el) el.classList.remove("hidden");
  }

  function showError(message) {
    errorMsg.textContent = message;
    showStatus(errorEl);
  }

  function setProgress(percent, phase) {
    const safePercent = Math.max(0, Math.min(100, percent));
    fillEl.style.width = `${safePercent}%`;
    percentEl.textContent = `${safePercent.toFixed(1)}%`;
    if (phase) phaseEl.textContent = phase;
  }

  function revokeCurrentUrls() {
    if (currentOriginalUrl) {
      URL.revokeObjectURL(currentOriginalUrl);
      currentOriginalUrl = null;
    }
    if (currentResultUrl) {
      URL.revokeObjectURL(currentResultUrl);
      currentResultUrl = null;
    }
  }

  function reset() {
    activeJobId += 1;
    if (currentApiController) {
      currentApiController.abort();
      currentApiController = null;
    }
    revokeCurrentUrls();
    apiKeyInput.value = "";
    apiKeyInput.removeAttribute("aria-invalid");
    setKeyVisibility(false);
    showStatus(null);
    fileInput.value = "";
    fillEl.style.width = "0%";
    percentEl.textContent = "0%";
    originalImg.src = "";
    resultImg.src = "";
    downloadBtn.removeAttribute("href");
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Không đọc được file ảnh."));
      reader.readAsDataURL(file);
    });
  }

  function closestAspectRatio(width, height) {
    const ratio = width / height;
    return OUTPUT_ASPECT_RATIOS.reduce((best, candidate) => {
      const bestDistance = Math.abs(Math.log(ratio / best[1]));
      const candidateDistance = Math.abs(Math.log(ratio / candidate[1]));
      return candidateDistance < bestDistance ? candidate : best;
    })[0];
  }

  function extensionFromMime(mimeType) {
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
    return "png";
  }

  function openRouterError(response, payload) {
    const providerMessage = payload?.error?.message || payload?.message;
    if (response.status === 401) return new Error("OpenRouter API key không hợp lệ hoặc đã hết hiệu lực.");
    if (response.status === 402) return new Error("Tài khoản OpenRouter không đủ credit để xử lý ảnh.");
    if (response.status === 413) return new Error("Ảnh quá lớn đối với OpenRouter. Hãy thử ảnh nhỏ hơn.");
    if (response.status === 429) return new Error("OpenRouter đang giới hạn tần suất. Vui lòng thử lại sau.");
    return new Error(providerMessage || `OpenRouter trả về lỗi HTTP ${response.status}.`);
  }

  async function finalizeResult(resultDataUrl, file, suffix, mimeType, jobId, isApi) {
    if (jobId !== activeJobId) return;
    setProgress(100, "Đang tạo file…");
    resultImg.src = resultDataUrl;

    const blob = await (await fetch(resultDataUrl)).blob();
    if (jobId !== activeJobId) return;
    if (currentResultUrl) URL.revokeObjectURL(currentResultUrl);
    currentResultUrl = URL.createObjectURL(blob);

    const baseName = file.name.replace(/\.[^.]+$/, "");
    const extension = extensionFromMime(mimeType || blob.type || "image/png");
    const downloadName = `${baseName}_${suffix}.${extension}`;
    downloadBtn.href = currentResultUrl;
    downloadBtn.download = downloadName;
    doneFile.textContent = downloadName;
    successEl.textContent = isApi ? "✓ AI Enhance xong" : "✓ Upscale xong";
    resultLabel.textContent = isApi ? "AI Enhance" : "Đã upscale";
    resultImg.alt = resultLabel.textContent;
    downloadLabel.textContent = isApi ? "Tải ảnh AI Enhance" : "Tải ảnh đã upscale";
    showStatus(doneEl);
  }

  async function runLocal(img, file, scale, jobId) {
    showStatus(loadingEl);
    loadingText.textContent = upscalerCache[scale]
      ? `Đang chuẩn bị model local ${scale}x…`
      : `Đang tải model local ${scale}x (lần đầu)…`;

    const upscaler = await ensureUpscaler(scale);
    if (jobId !== activeJobId) return;

    showStatus(progressEl);
    setProgress(0, "Đang xử lý local…");
    const resultDataUrl = await upscaler.upscale(img, {
      patchSize: 128,
      padding: 8,
      progress: (rate) => {
        if (jobId === activeJobId) {
          setProgress(Math.max(0, Math.min(99.9, rate * 100)), "Đang xử lý local…");
        }
      },
    });

    await finalizeResult(resultDataUrl, file, `upscaled_${scale}x`, "image/png", jobId, false);
  }

  async function runOpenRouter(img, file, model, resolution, jobId) {
    const apiKey = apiKeyInput.value.trim();
    setProgress(8, "Đang đọc ảnh để gửi…");
    const imageDataUrl = await fileToDataUrl(file);
    if (jobId !== activeJobId) return;

    const controller = new AbortController();
    currentApiController = controller;
    const aspectRatio = closestAspectRatio(img.naturalWidth || img.width, img.naturalHeight || img.height);
    const prompt = [
      `Upscale and restore this image to ${resolution}.`,
      "Preserve the exact composition, subject identity, facial features, text, colors, lighting, camera angle and aspect ratio.",
      "Remove compression artifacts and noise, recover natural fine details and sharp edges.",
      "Do not add, remove, crop, redesign or reposition anything.",
    ].join(" ");

    setProgress(20, "Đang gửi tới OpenRouter…");
    // Key chỉ được dùng để tạo header request, không ghi vào storage/cookie/URL.
    const request = fetch("https://openrouter.ai/api/v1/images", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt,
        resolution,
        aspect_ratio: aspectRatio,
        n: 1,
        input_references: [
          {
            type: "image_url",
            image_url: { url: imageDataUrl },
          },
        ],
      }),
      signal: controller.signal,
    });

    // Xóa khỏi DOM ngay khi request đã được tạo; không giữ key cho lần sau.
    apiKeyInput.value = "";
    setKeyVisibility(false);

    try {
      const response = await request;
      if (jobId !== activeJobId) return;
      setProgress(85, "Đang nhận ảnh kết quả…");

      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) throw openRouterError(response, payload);

      const output = payload?.data?.[0];
      if (!output?.b64_json) {
        throw new Error("OpenRouter không trả về dữ liệu ảnh hợp lệ.");
      }

      const mimeType = output.media_type || "image/png";
      const resultDataUrl = output.b64_json.startsWith("data:")
        ? output.b64_json
        : `data:${mimeType};base64,${output.b64_json}`;
      const modelName = model.split("/").pop().replace(/[^a-z0-9-]+/gi, "-");
      await finalizeResult(resultDataUrl, file, `ai_${modelName}_${resolution.toLowerCase()}`, mimeType, jobId, true);
    } finally {
      if (currentApiController === controller) currentApiController = null;
    }
  }

  async function handleFile(file) {
    if (!file.type || !file.type.startsWith("image/")) {
      showError("File không phải ảnh hợp lệ.");
      return;
    }

    const engine = getEngine();
    if (engine === "openrouter" && !apiKeyInput.value.trim()) {
      apiKeyInput.setAttribute("aria-invalid", "true");
      showError("Hãy nhập OpenRouter API key trước khi chọn ảnh.");
      apiKeyInput.focus();
      return;
    }
    apiKeyInput.removeAttribute("aria-invalid");

    if (currentApiController) currentApiController.abort();
    const jobId = ++activeJobId;
    const scale = parseInt(scaleSelect.value, 10) || 4;
    const model = OPENROUTER_MODELS.has(apiModelSelect.value)
      ? apiModelSelect.value
      : "bytedance-seed/seedream-4.5";

    filenameEl.textContent = file.name;
    showStatus(progressEl);
    setProgress(0, "Đang đọc ảnh…");

    if (currentOriginalUrl) URL.revokeObjectURL(currentOriginalUrl);
    currentOriginalUrl = URL.createObjectURL(file);
    const img = new Image();
    img.src = currentOriginalUrl;

    try {
      await img.decode();
      if (jobId !== activeJobId) return;
      originalImg.src = currentOriginalUrl;

      if (engine === "openrouter") {
        await runOpenRouter(img, file, model, `${scale}K`, jobId);
      } else {
        await runLocal(img, file, scale, jobId);
      }
    } catch (error) {
      if (error?.name === "AbortError" || jobId !== activeJobId) return;
      console.error("[upscale]", error);
      showError(error?.message || String(error));
    }
  }

  dropzone.addEventListener("click", (event) => {
    if (event.target !== fileInput) fileInput.click();
  });
  dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", (event) => {
    if (event.target.files?.[0]) handleFile(event.target.files[0]);
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      dropzone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      dropzone.classList.remove("dragover");
    });
  });
  dropzone.addEventListener("drop", (event) => {
    if (event.dataTransfer.files?.[0]) handleFile(event.dataTransfer.files[0]);
  });

  window.addEventListener("dragover", (event) => {
    if (panel && !panel.classList.contains("hidden")) event.preventDefault();
  });
  window.addEventListener("drop", (event) => {
    if (panel && !panel.classList.contains("hidden")) event.preventDefault();
  });
  window.addEventListener("pagehide", () => {
    apiKeyInput.value = "";
    if (currentApiController) currentApiController.abort();
  });

  engineInputs.forEach((input) => input.addEventListener("change", updateEngineUi));
  apiKeyInput.addEventListener("input", () => apiKeyInput.removeAttribute("aria-invalid"));
  toggleKeyBtn.addEventListener("click", () => setKeyVisibility(apiKeyInput.type === "password"));
  resetBtn.addEventListener("click", reset);
  retryBtn.addEventListener("click", reset);

  updateEngineUi();
})();
