use crate::types::{MediaInfo, MediaItem};
use anyhow::{anyhow, Result};
use serde_json::Value;

pub async fn fetch(client: &reqwest::Client, url: &str) -> Result<MediaInfo> {
    let api = format!(
        "https://www.tikwm.com/api/?url={}&hd=1",
        urlencoding::encode(url)
    );
    let json: Value = client.get(&api).send().await?.error_for_status()?.json().await?;

    if json.get("code").and_then(Value::as_i64) != Some(0) {
        return Err(anyhow!(json.get("msg")
            .and_then(Value::as_str)
            .unwrap_or("Không lấy được dữ liệu từ TikTok.")
            .to_string()));
    }
    let d = json
        .get("data")
        .ok_or_else(|| anyhow!("Phản hồi TikTok thiếu data."))?;

    let title = d.get("title").and_then(Value::as_str).unwrap_or("").to_string();
    let author_obj = d.get("author");
    let author = author_obj
        .and_then(|a| a.get("nickname").and_then(Value::as_str))
        .or_else(|| author_obj.and_then(|a| a.get("unique_id").and_then(Value::as_str)))
        .unwrap_or("")
        .to_string();
    let author_avatar = author_obj
        .and_then(|a| a.get("avatar").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    let thumbnail = d.get("cover").and_then(Value::as_str).unwrap_or("").to_string();

    // Carousel ảnh
    if let Some(images) = d.get("images").and_then(Value::as_array) {
        if !images.is_empty() {
            let items = images
                .iter()
                .filter_map(|v| v.as_str())
                .map(|u| MediaItem { kind: "image".into(), url: u.to_string() })
                .collect();
            return Ok(MediaInfo {
                media_type: "carousel".into(),
                items: Some(items),
                title,
                author,
                author_avatar,
                thumbnail,
                platform: "tiktok".into(),
                ..Default::default()
            });
        }
    }

    let video = d
        .get("hdplay")
        .and_then(Value::as_str)
        .or_else(|| d.get("play").and_then(Value::as_str))
        .or_else(|| d.get("wmplay").and_then(Value::as_str))
        .ok_or_else(|| anyhow!("Không tìm thấy URL video TikTok."))?;

    let duration = d.get("duration").and_then(Value::as_u64);

    Ok(MediaInfo {
        media_type: "video".into(),
        url: Some(video.to_string()),
        title,
        author,
        author_avatar,
        thumbnail,
        platform: "tiktok".into(),
        duration,
        ..Default::default()
    })
}
