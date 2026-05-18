use crate::types::MediaInfo;
use crate::{snapsave, tikwm};
use anyhow::anyhow;
use futures_util::StreamExt;
use once_cell::sync::Lazy;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;

static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) \
             Chrome/121.0.0.0 Mobile Safari/537.36",
        )
        .gzip(true)
        .brotli(true)
        .timeout(Duration::from_secs(25))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .expect("failed to build reqwest client")
});

fn map_err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn fetch_tiktok(url: String) -> Result<MediaInfo, String> {
    tikwm::fetch(&CLIENT, &url).await.map_err(map_err)
}

#[tauri::command]
pub async fn fetch_instagram(url: String) -> Result<MediaInfo, String> {
    let html = snapsave::call(&CLIENT, &url).await.map_err(map_err)?;
    snapsave::parse(&html, "instagram")
        .ok_or_else(|| "Không tải được nội dung Instagram (có thể là tài khoản riêng tư).".into())
}

#[tauri::command]
pub async fn fetch_facebook(url: String) -> Result<MediaInfo, String> {
    let html = snapsave::call(&CLIENT, &url).await.map_err(map_err)?;
    snapsave::parse(&html, "facebook")
        .ok_or_else(|| "Không tải được video Facebook (có thể là nội dung riêng tư).".into())
}

#[tauri::command]
pub async fn download_media(
    app: AppHandle,
    url: String,
    filename: String,
) -> Result<String, String> {
    let dir = pick_download_dir(&app).map_err(map_err)?;
    tokio::fs::create_dir_all(&dir).await.map_err(map_err)?;
    let safe_name = sanitize_filename(&filename);
    let target = dir.join(&safe_name);

    let resp = CLIENT
        .get(&url)
        .send()
        .await
        .map_err(map_err)?
        .error_for_status()
        .map_err(map_err)?;

    let mut file = tokio::fs::File::create(&target).await.map_err(map_err)?;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(map_err)?;
        file.write_all(&bytes).await.map_err(map_err)?;
    }
    file.flush().await.map_err(map_err)?;

    Ok(target.to_string_lossy().into_owned())
}

fn pick_download_dir(app: &AppHandle) -> anyhow::Result<PathBuf> {
    // Trên Android, app.path().download_dir() trả về thư mục Downloads công cộng.
    // Trên desktop, trả về ~/Downloads.
    let path = app
        .path()
        .download_dir()
        .map_err(|e| anyhow!("không lấy được Downloads dir: {e}"))?;
    Ok(path.join("Leakred"))
}

fn sanitize_filename(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0') {
            out.push('_');
        } else {
            out.push(c);
        }
    }
    if out.is_empty() { "download.bin".into() } else { out }
}
