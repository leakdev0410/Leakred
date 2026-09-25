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
  const modeInputs = document.querySelectorAll('input[name="upcMode"]');
  const modeNoteEl = document.getElementById("upcModeNote");
  const promptField = document.getElementById("upcPromptField");
  const promptInput = document.getElementById("upcPrompt");
  const promptCount = document.getElementById("upcPromptCount");
  const aspectField = document.getElementById("upcAspectField");
  const aspectSelect = document.getElementById("upcAspect");
  const generateBtn = document.getElementById("upcGenerate");
  const originalWrap = document.getElementById("upcOriginalWrap");
  const promptPanel = document.getElementById("upcPromptPanel");
  const promptDisplay = document.getElementById("upcPromptDisplay");
  const stagedPreview = document.getElementById("upcStagedPreview");
  const stagedImg = document.getElementById("upcStagedImg");
  const stagedName = document.getElementById("upcStagedName");
  const stagedClearBtn = document.getElementById("upcStagedClear");

  if (!dropzone) return;

  const upscalerCache = {};
  const upscalerLoading = {};
  let currentOriginalUrl = null;
  let currentResultUrl = null;
  let currentApiController = null;
  let activeJobId = 0;
  let pendingImageFile = null;
  let pendingImageUrl = null;

  function getMode() {
    return document.querySelector('input[name="upcMode"]:checked')?.value || "upscale-local";
  }

  const MODE_CONFIG = {
    "upscale-local": {
      showDropzone: true,
      showPrompt: false,
      showAspect: false,
      showGenerate: false,
      showApiSettings: false,
      scaleLabel: "Mức phóng to",
      scaleOptions: ["2x", "4x"],
      intro: "Upscale riêng tư bằng model local chạy ngay trong trình duyệt. Ảnh không rời khỏi thiết bị.",
      modeNote: "Local dùng ESRGAN-slim và không tải ảnh lên mạng.",
      dropHint: "jpg, png, webp… · ảnh càng lớn xử lý càng lâu",
    },
    "upscale-openrouter": {
      showDropzone: true,
      showPrompt: false,
      showAspect: false,
      showGenerate: false,
      showApiSettings: true,
      scaleLabel: "Độ phân giải đầu ra",
      scaleOptions: ["2K", "4K"],
      intro: "AI Enhance bằng model ảnh trên OpenRouter, phù hợp khi cần phục hồi và tái tạo thêm chi tiết.",
      modeNote: "Ảnh và prompt sẽ gửi trực tiếp tới OpenRouter/provider. Trang không lưu API key.",
      dropHint: "jpg, png, webp… · ảnh sẽ được gửi tới OpenRouter để xử lý",
    },
    "text-to-image": {
      showDropzone: false,
      showPrompt: true,
      showAspect: true,
      showGenerate: true,
      showApiSettings: true,
      scaleLabel: "Độ phân giải đầu ra",
      scaleOptions: ["2K", "4K"],
      intro: "Tạo ảnh mới từ prompt bằng các model AI trên OpenRouter.",
      modeNote: "Không cần ảnh đầu vào. Prompt và API key được gửi tới OpenRouter.",
      dropHint: "",
    },
    "image-to-image": {
      showDropzone: true,
      showPrompt: true,
      showAspect: false,
      showGenerate: true,
      showApiSettings: true,
      scaleLabel: "Độ phân giải đầu ra",
      scaleOptions: ["2K", "4K"],
      intro: "Chỉnh sửa ảnh có sẵn theo prompt bằng các model AI trên OpenRouter.",
      modeNote: "Ảnh và prompt được gửi tới OpenRouter. Trang không lưu API key.",
      dropHint: "jpg, png, webp… · ảnh sẽ được gửi tới OpenRouter kèm prompt",
    },
  };

  function getModeConfig() {
    return MODE_CONFIG[getMode()] || MODE_CONFIG["upscale-local"];
  }

  function applyScaleOptions(config) {
    if (scaleLabel) scaleLabel.textContent = config.scaleLabel;
    if (scaleSelect?.options?.[0]) scaleSelect.options[0].textContent = config.scaleOptions[0];
    if (scaleSelect?.options?.[1]) scaleSelect.options[1].textContent = config.scaleOptions[1];
  }

  function updateModeUi() {
    const mode = getMode();
    const config = getModeConfig();
    const isI2I = mode === "image-to-image";

    if (promptField) promptField.hidden = !config.showPrompt;
    if (aspectField) aspectField.hidden = !config.showAspect;
    if (generateBtn) generateBtn.hidden = !config.showGenerate;
    if (apiSettings) apiSettings.hidden = !config.showApiSettings;
    if (dropzone) dropzone.hidden = !config.showDropzone;
    if (fileInput) fileInput.value = "";

    if (introEl) introEl.textContent = config.intro;
    if (modeNoteEl) modeNoteEl.textContent = config.modeNote;
    if (dropHint) dropHint.textContent = config.dropHint;

    if (!isI2I) clearPendingImage();

    applyScaleOptions(config);
    reset();
    updateGenerateButtonState();
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
    if (promptInput) {
      promptInput.value = "";
      promptInput.removeAttribute("aria-invalid");
    }
    updatePromptCount();
    clearPendingImage();
    showStatus(null);
    fileInput.value = "";
    fillEl.style.width = "0%";
    percentEl.textContent = "0%";
    originalImg.src = "";
    resultImg.src = "";
    downloadBtn.removeAttribute("href");
    if (originalWrap) originalWrap.hidden = false;
    if (promptPanel) promptPanel.hidden = true;
    if (promptDisplay) promptDisplay.textContent = "";
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

  function slugifyPrompt(text) {
    const slug = text
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/đ/g, "d")
      .replace(/[^a-z0-9\s-]+/g, " ")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    return slug || "generated";
  }

  function validatePrompt(prompt) {
    if (!prompt) return "Vui lòng nhập mô tả ảnh trước khi tạo.";
    if (prompt.length > 1000) return "Mô tả quá dài (tối đa 1000 ký tự).";
    return null;
  }

  function updatePromptCount() {
    if (!promptCount) return;
    const len = promptInput?.value?.length || 0;
    promptCount.textContent = `${len}/1000`;
  }

  function setPendingImage(file) {
    clearPendingImage();
    pendingImageFile = file;
    pendingImageUrl = URL.createObjectURL(file);
    if (stagedImg) stagedImg.src = pendingImageUrl;
    if (stagedName) stagedName.textContent = file.name;
    if (stagedPreview) stagedPreview.hidden = false;
    updateGenerateButtonState();
  }

  function clearPendingImage() {
    if (pendingImageUrl) {
      URL.revokeObjectURL(pendingImageUrl);
      pendingImageUrl = null;
    }
    pendingImageFile = null;
    if (stagedImg) stagedImg.src = "";
    if (stagedName) stagedName.textContent = "";
    if (stagedPreview) stagedPreview.hidden = true;
    updateGenerateButtonState();
  }

  function updateGenerateButtonState() {
    if (!generateBtn) return;
    const mode = getMode();
    if (mode === "text-to-image") {
      generateBtn.disabled = false;
    } else if (mode === "image-to-image") {
      const hasImage = !!pendingImageFile;
      const hasPrompt = !!(promptInput?.value || "").trim();
      generateBtn.disabled = !(hasImage && hasPrompt);
    } else {
      generateBtn.disabled = true;
    }
  }

  function openRouterError(response, payload) {
    const providerMessage = payload?.error?.message || payload?.message;
    if (response.status === 401) return new Error("OpenRouter API key không hợp lệ hoặc đã hết hiệu lực.");
    if (response.status === 402) return new Error("Tài khoản OpenRouter không đủ credit để xử lý ảnh.");
    if (response.status === 413) return new Error("Ảnh quá lớn đối với OpenRouter. Hãy thử ảnh nhỏ hơn.");
    if (response.status === 429) return new Error("OpenRouter đang giới hạn tần suất. Vui lòng thử lại sau.");
    return new Error(providerMessage || `OpenRouter trả về lỗi HTTP ${response.status}.`);
  }

  async function finalizeResult(opts) {
    const {
      resultDataUrl,
      downloadName,
      jobId,
      successText,
      resultLabelText,
      downloadLabelText,
      altText,
      mode,
      promptText = "",
    } = opts;
    if (jobId !== activeJobId) return;
    setProgress(100, "Đang tạo file…");
    resultImg.src = resultDataUrl;

    const blob = await (await fetch(resultDataUrl)).blob();
    if (jobId !== activeJobId) return;
    if (currentResultUrl) URL.revokeObjectURL(currentResultUrl);
    currentResultUrl = URL.createObjectURL(blob);

    downloadBtn.href = currentResultUrl;
    downloadBtn.download = downloadName;
    doneFile.textContent = downloadName;
    successEl.textContent = successText;
    resultLabel.textContent = resultLabelText;
    resultImg.alt = altText || resultLabelText;
    downloadLabel.textContent = downloadLabelText;

    if (mode === "text-to-image") {
      if (originalWrap) originalWrap.hidden = true;
      if (promptPanel) promptPanel.hidden = false;
      if (promptDisplay) promptDisplay.textContent = promptText;
    } else {
      if (originalWrap) originalWrap.hidden = false;
      if (promptPanel) promptPanel.hidden = true;
      if (promptDisplay) promptDisplay.textContent = "";
    }

    showStatus(doneEl);
  }

  function buildUpscaleFileName(file, suffix) {
    const baseName = file.name.replace(/\.[^.]+$/, "");
    return `${baseName}_${suffix}`;
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

    const downloadName = `${buildUpscaleFileName(file, `upscaled_${scale}x`)}.png`;
    await finalizeResult({
      resultDataUrl,
      downloadName,
      jobId,
      successText: "✓ Upscale xong",
      resultLabelText: "Đã upscale",
      downloadLabelText: "Tải ảnh đã upscale",
      altText: "Ảnh đã upscale",
      mode: "upscale",
    });
  }

  async function runOpenRouter(img, file, model, resolution, jobId, customPrompt = null) {
    const apiKey = apiKeyInput.value.trim();
    setProgress(8, "Đang đọc ảnh để gửi…");
    const imageDataUrl = await fileToDataUrl(file);
    if (jobId !== activeJobId) return;

    const controller = new AbortController();
    currentApiController = controller;
    const aspectRatio = closestAspectRatio(img.naturalWidth || img.width, img.naturalHeight || img.height);
    const defaultPrompt = [
      `Upscale and restore this image to ${resolution}.`,
      "Preserve the exact composition, subject identity, facial features, text, colors, lighting, camera angle and aspect ratio.",
      "Remove compression artifacts and noise, recover natural fine details and sharp edges.",
      "Do not add, remove, crop, redesign or reposition anything.",
    ].join(" ");
    const prompt = customPrompt || defaultPrompt;

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
      const extension = extensionFromMime(mimeType);
      const downloadName = `${buildUpscaleFileName(file, `ai_${modelName}_${resolution.toLowerCase()}`)}.${extension}`;
      await finalizeResult({
        resultDataUrl,
        downloadName,
        jobId,
        successText: "✓ AI Enhance xong",
        resultLabelText: "AI Enhance",
        downloadLabelText: "Tải ảnh AI Enhance",
        altText: "Ảnh AI Enhance",
        mode: "upscale",
      });
    } finally {
      if (currentApiController === controller) currentApiController = null;
    }
  }

  async function runOpenRouterTextToImage(prompt, model, resolution, aspectRatio, slug, jobId) {
    const apiKey = apiKeyInput.value.trim();

    const controller = new AbortController();
    currentApiController = controller;

    setProgress(20, "Đang gửi tới OpenRouter…");
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
      }),
      signal: controller.signal,
    });

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
      const extension = extensionFromMime(mimeType);
      const downloadName = `${slug}_ai_${modelName}_${resolution.toLowerCase()}.${extension}`;

      await finalizeResult({
        resultDataUrl,
        downloadName,
        jobId,
        successText: "✓ Đã tạo ảnh",
        resultLabelText: "Ảnh đã tạo",
        downloadLabelText: "Tải ảnh đã tạo",
        altText: "Ảnh đã tạo từ prompt",
        mode: "text-to-image",
        promptText: prompt,
      });
    } finally {
      if (currentApiController === controller) currentApiController = null;
    }
  }

  async function handleImageSubmit(file) {
    const mode = getMode();

    if (mode === "image-to-image") {
      if (!file.type || !file.type.startsWith("image/")) {
        showError("File không phải ảnh hợp lệ.");
        return;
      }
      setPendingImage(file);
      return;
    }

    if (mode !== "upscale-local" && mode !== "upscale-openrouter") return;

    if (!file.type || !file.type.startsWith("image/")) {
      showError("File không phải ảnh hợp lệ.");
      return;
    }

    if (mode === "upscale-openrouter" && !apiKeyInput.value.trim()) {
      apiKeyInput.setAttribute("aria-invalid", "true");
      showError("Hãy nhập OpenRouter API key trước khi chọn ảnh.");
      apiKeyInput.focus();
      return;
    }
    apiKeyInput.removeAttribute("aria-invalid");

    if (currentApiController) currentApiController.abort();
    const jobId = ++activeJobId;
    const scale = parseInt(scaleSelect.value, 10) || 4;

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

      if (mode === "upscale-local") {
        await runLocal(img, file, scale, jobId);
      } else {
        const resolution = `${scale}K`;
        const model = OPENROUTER_MODELS.has(apiModelSelect.value)
          ? apiModelSelect.value
          : "bytedance-seed/seedream-4.5";
        await runOpenRouter(img, file, model, resolution, jobId);
      }
    } catch (error) {
      if (error?.name === "AbortError" || jobId !== activeJobId) return;
      console.error("[upscale]", error);
      showError(error?.message || String(error));
    }
  }

  async function handleTextToImageSubmit() {
    if (getMode() !== "text-to-image") return;

    const prompt = (promptInput?.value || "").trim();
    const err = validatePrompt(prompt);
    if (err) {
      if (promptInput) promptInput.setAttribute("aria-invalid", "true");
      showError(err);
      if (promptInput) promptInput.focus();
      return;
    }
    if (promptInput) promptInput.removeAttribute("aria-invalid");

    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      apiKeyInput.setAttribute("aria-invalid", "true");
      showError("Hãy nhập OpenRouter API key trước khi tạo ảnh.");
      apiKeyInput.focus();
      return;
    }
    apiKeyInput.removeAttribute("aria-invalid");

    if (currentApiController) currentApiController.abort();
    const jobId = ++activeJobId;
    const scale = parseInt(scaleSelect.value, 10) || 4;
    const resolution = `${scale}K`;
    const model = OPENROUTER_MODELS.has(apiModelSelect.value)
      ? apiModelSelect.value
      : "bytedance-seed/seedream-4.5";
    const aspectRatio = aspectSelect?.value || "1:1";
    const slug = slugifyPrompt(prompt);

    const preview = prompt.length > 64 ? prompt.slice(0, 64) + "…" : prompt;
    filenameEl.textContent = `Đang tạo: "${preview}"`;
    showStatus(progressEl);
    setProgress(5, "Đang chuẩn bị prompt…");

    generateBtn?.classList.add("loading");
    try {
      await runOpenRouterTextToImage(prompt, model, resolution, aspectRatio, slug, jobId);
    } catch (error) {
      if (error?.name === "AbortError" || jobId !== activeJobId) return;
      console.error("[upscale]", error);
      showError(error?.message || String(error));
    } finally {
      generateBtn?.classList.remove("loading");
    }
  }

  async function handleImageToImageSubmit() {
    if (getMode() !== "image-to-image") return;

    const file = pendingImageFile;
    const prompt = (promptInput?.value || "").trim();

    const err = validatePrompt(prompt);
    if (err) {
      if (promptInput) promptInput.setAttribute("aria-invalid", "true");
      showError(err);
      if (promptInput) promptInput.focus();
      return;
    }
    if (promptInput) promptInput.removeAttribute("aria-invalid");

    if (!file) {
      showError("Hãy chọn ảnh trước khi tạo.");
      return;
    }

    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      apiKeyInput.setAttribute("aria-invalid", "true");
      showError("Hãy nhập OpenRouter API key trước khi tạo ảnh.");
      apiKeyInput.focus();
      return;
    }
    apiKeyInput.removeAttribute("aria-invalid");

    if (currentApiController) currentApiController.abort();
    const jobId = ++activeJobId;
    const scale = parseInt(scaleSelect.value, 10) || 4;
    const resolution = `${scale}K`;
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

    generateBtn?.classList.add("loading");
    try {
      await img.decode();
      if (jobId !== activeJobId) return;
      originalImg.src = currentOriginalUrl;
      await runOpenRouter(img, file, model, resolution, jobId, prompt);
    } catch (error) {
      if (error?.name === "AbortError" || jobId !== activeJobId) return;
      console.error("[upscale]", error);
      showError(error?.message || String(error));
    } finally {
      generateBtn?.classList.remove("loading");
    }
  }

  async function handleGenerate() {
    const mode = getMode();
    if (mode === "text-to-image") {
      await handleTextToImageSubmit();
    } else if (mode === "image-to-image") {
      await handleImageToImageSubmit();
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
    if (event.target.files?.[0]) handleImageSubmit(event.target.files[0]);
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
    if (event.dataTransfer.files?.[0]) handleImageSubmit(event.dataTransfer.files[0]);
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

  modeInputs.forEach((input) => input.addEventListener("change", updateModeUi));
  apiKeyInput.addEventListener("input", () => apiKeyInput.removeAttribute("aria-invalid"));
  promptInput?.addEventListener("input", () => {
    promptInput.removeAttribute("aria-invalid");
    updatePromptCount();
    updateGenerateButtonState();
  });
  promptInput?.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      if (!generateBtn.hidden) handleGenerate();
    }
  });
  toggleKeyBtn.addEventListener("click", () => setKeyVisibility(apiKeyInput.type === "password"));
  generateBtn?.addEventListener("click", handleGenerate);
  stagedClearBtn?.addEventListener("click", clearPendingImage);
  resetBtn.addEventListener("click", reset);
  retryBtn.addEventListener("click", reset);

  updateModeUi();
})();
