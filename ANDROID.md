# Build Leakred APK với Tauri 2 (Rust)

App web hiện tại (`index.html`/`style.css`/`script.js`) được wrap bằng Tauri 2.
Khi chạy trong Tauri (Android hoặc desktop), `script.js` tự gọi backend Rust qua
`invoke()` → HTTP request đi từ native, **không cần CORS proxy** nữa.

## 1. Cài môi trường (một lần)

| Tool | Phiên bản | Ghi chú |
|---|---|---|
| Rust | stable ≥ 1.77 | `rustup default stable` |
| Android Studio | mới nhất | Cần SDK Platform 34, NDK ≥ 26, Build-Tools 34, Command-line Tools |
| JDK | 17 | OpenJDK 17 |
| Tauri CLI | 2.x | `cargo install tauri-cli --version "^2.0"` |

Set biến môi trường (vd ~/.zshrc):

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/$(ls -1 $ANDROID_HOME/ndk | tail -n1)"
export JAVA_HOME="/usr/lib/jvm/java-17-openjdk"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
```

Cài Rust targets cho Android:
```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

## 2. Khởi tạo Android project (một lần)

```bash
cd src-tauri
cargo tauri android init
```

Lệnh này sinh `src-tauri/gen/android/` với Gradle project. Đã thêm vào
`.gitignore` để không commit build artifacts.

## 3. Tạo icon (một lần, cần PNG nguồn ≥ 1024×1024)

```bash
cd src-tauri
cargo tauri icon /path/to/source.png
```

## 4. Build & chạy

**Chạy dev trên thiết bị/emulator (USB debugging ON):**
```bash
cd src-tauri
cargo tauri android dev
```

**Build APK release:**
```bash
cd src-tauri
cargo tauri android build
# APK output:
#   gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
```

**Build APK theo từng ABI (nhẹ hơn ~3×):**
```bash
cargo tauri android build --apk --target aarch64
```

## 5. Ký APK để cài/upload Play Store

```bash
keytool -genkeypair -v -keystore leakred.keystore -alias leakred \
  -keyalg RSA -keysize 2048 -validity 10000
apksigner sign --ks leakred.keystore \
  --out leakred-signed.apk app-universal-release-unsigned.apk
```

## Cấu trúc đã scaffold

```
src-tauri/
├── Cargo.toml           # deps: tauri 2, reqwest (rustls), scraper, …
├── build.rs
├── tauri.conf.json      # frontendDist = "../" (web app gốc)
├── capabilities/
│   └── default.json
├── icons/               # cần `cargo tauri icon ...`
└── src/
    ├── main.rs          # entry desktop
    ├── lib.rs           # run() + mobile_entry_point
    ├── commands.rs      # 4 Tauri commands gọi từ JS
    ├── snapsave.rs      # decryption + parser HTML
    ├── tikwm.rs         # TikTok via tikwm.com
    └── types.rs         # MediaInfo struct
```

## Tauri commands

| JS gọi | Rust handler | Trả về |
|---|---|---|
| `invoke("fetch_tiktok", { url })` | `commands::fetch_tiktok` | `MediaInfo` |
| `invoke("fetch_instagram", { url })` | `commands::fetch_instagram` | `MediaInfo` |
| `invoke("fetch_facebook", { url })` | `commands::fetch_facebook` | `MediaInfo` |
| `invoke("download_media", { url, filename })` | `commands::download_media` | `string` (path đã lưu) |

File tải về được lưu tại **`<Downloads>/Leakred/<filename>`**.

## Lưu ý production

- **Cập nhật snapsave**: nếu snapsave đổi obfuscation, sửa `src-tauri/src/snapsave.rs`.
- **TLS roots**: dùng `rustls-tls-webpki-roots`, không phụ thuộc OS cert store.
- **Min SDK**: 24 (Android 7.0). Đổi trong `tauri.conf.json` nếu cần.
- **Permission**: chỉ cần `INTERNET` (Tauri tự thêm). Lưu xuống `Downloads/Leakred`
  qua scoped storage nên không cần `WRITE_EXTERNAL_STORAGE` trên Android ≥ 10.
- **Web bản gốc vẫn chạy được**: `script.js` detect `window.__TAURI__`, nếu không
  có thì fallback về CORS proxy. Không cần fork code.
