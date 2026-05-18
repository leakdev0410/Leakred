// Port của thuật toán snapsave decryption + parser HTML
// Tham khảo: https://github.com/ahmedrangel/snapsave-media-downloader
use crate::types::{MediaInfo, MediaItem};
use anyhow::{anyhow, Context, Result};
use scraper::{Html, Selector};

const ALPHABET: &str = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/";

/// decodeSnapApp port — giải mã các đối số của hàm IIFE mà snapsave trả về.
fn decode_snap_app(args: &[String]) -> Result<String> {
    if args.len() < 5 {
        return Err(anyhow!("snapsave: thiếu argument để decode"));
    }
    let h: Vec<char> = args[0].chars().collect();
    let n: Vec<char> = args[2].chars().collect();
    let t_num: i64 = args[3].parse().context("t không phải số")?;
    let e_num: usize = args[4].parse().context("e không phải số")?;

    let delim = *n.get(e_num).ok_or_else(|| anyhow!("delimiter ngoài range"))?;
    let n_str: String = n.iter().collect();
    let base = e_num as u64;

    let mut bytes: Vec<u8> = Vec::with_capacity(h.len() / 2);
    let mut i = 0;
    while i < h.len() {
        let mut s = String::new();
        while i < h.len() && h[i] != delim {
            s.push(h[i]);
            i += 1;
        }
        i += 1; // skip delimiter

        // Thay từng ký tự trong n bằng index
        let mut replaced = s;
        for (j, ch) in n_str.chars().enumerate() {
            replaced = replaced.replace(ch, &j.to_string());
        }

        // Đọc chuỗi đã thay theo base = e_num
        let mut value: u64 = 0;
        for (idx, c) in replaced.chars().rev().enumerate() {
            if let Some(pos) = ALPHABET.find(c) {
                if (pos as u64) < base {
                    value = value.saturating_add((pos as u64) * base.pow(idx as u32));
                }
            }
        }
        let code = (value as i64 - t_num) as u32 & 0xFF;
        bytes.push(code as u8);
    }

    // Tái diễn giải bytes như UTF-8 (giống TextDecoder.decode trong JS)
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Bóc các argument từ payload `decodeURIComponent(escape(r))}(...)`
fn extract_args(data: &str) -> Result<Vec<String>> {
    let after = data
        .split("decodeURIComponent(escape(r))}(")
        .nth(1)
        .ok_or_else(|| anyhow!("snapsave: không tìm thấy payload"))?;
    let body = after.split("))").next().unwrap_or("");
    Ok(body
        .split(',')
        .map(|v| v.replace('"', "").trim().to_string())
        .collect())
}

/// decryptSnapSave port — trả về HTML thuần sau khi giải mã JS obfuscated.
pub fn decrypt_snapsave(raw: &str) -> Result<String> {
    if let Some(err) = raw
        .split("document.querySelector(\"#alert\").innerHTML = \"")
        .nth(1)
        .and_then(|s| s.split("\";").next())
    {
        let trimmed = err.trim();
        if !trimmed.is_empty() {
            return Err(anyhow!(trimmed.to_string()));
        }
    }
    let args = extract_args(raw)?;
    let decoded = decode_snap_app(&args)?;
    let part = decoded
        .split("getElementById(\"download-section\").innerHTML = \"")
        .nth(1)
        .ok_or_else(|| anyhow!("snapsave: response không như mong đợi"))?;
    let html = part
        .split("\"; document.getElementById(\"inputData\").remove(); ")
        .next()
        .unwrap_or("")
        .replace("\\\\", "\\")
        .replace("\\/", "/")
        .replace("\\\"", "\"");
    Ok(html)
}

pub async fn call(client: &reqwest::Client, url: &str) -> Result<String> {
    let body = format!("url={}", urlencoding::encode(url));
    let raw = client
        .post("https://snapsave.app/action.php?lang=en")
        .header("Accept", "*/*")
        .header("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
        .header("Origin", "https://snapsave.app")
        .header("Referer", "https://snapsave.app/")
        .header("X-Requested-With", "XMLHttpRequest")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) \
             Chrome/121.0.0.0 Mobile Safari/537.36",
        )
        .body(body)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    decrypt_snapsave(&raw)
}

pub fn parse(html: &str, platform: &str) -> Option<MediaInfo> {
    let doc = Html::parse_document(html);

    let desc = doc
        .select(&Selector::parse("span.video-des").unwrap())
        .next()
        .map(|el| el.text().collect::<String>().trim().to_string())
        .unwrap_or_default();
    let figure_thumb = doc
        .select(&Selector::parse("article.media figure img").unwrap())
        .next()
        .and_then(|el| el.value().attr("src"))
        .unwrap_or("")
        .to_string();

    // Pattern A: bảng nhiều resolution (FB)
    if let Ok(sel) = Selector::parse("table.table tbody tr") {
        let rows: Vec<_> = doc.select(&sel).collect();
        if !rows.is_empty() {
            let mut videos: Vec<(String, String)> = vec![]; // (resolution, url)
            for tr in &rows {
                let tds: Vec<_> = tr.select(&Selector::parse("td").unwrap()).collect();
                if tds.len() < 3 { continue; }
                let resolution = tds[0].text().collect::<String>().trim().to_string();
                let mut url_val = tds[2]
                    .select(&Selector::parse("a").unwrap())
                    .next()
                    .and_then(|a| a.value().attr("href"))
                    .map(String::from)
                    .unwrap_or_default();
                if url_val.is_empty() {
                    url_val = tds[2]
                        .select(&Selector::parse("button").unwrap())
                        .next()
                        .and_then(|b| b.value().attr("onclick"))
                        .map(String::from)
                        .unwrap_or_default();
                }
                if url_val.is_empty() || url_val == "#" { continue; }
                if url_val.contains("get_progressApi") {
                    if let Some(start) = url_val.find("get_progressApi('") {
                        let tail = &url_val[start + "get_progressApi('".len()..];
                        if let Some(end) = tail.find('\'') {
                            url_val = format!("https://snapsave.app{}", &tail[..end]);
                        }
                    }
                }
                videos.push((resolution, url_val));
            }
            if let Some((_, first_url)) = videos.first().cloned() {
                return Some(MediaInfo {
                    media_type: "video".into(),
                    url: Some(first_url),
                    title: desc,
                    thumbnail: figure_thumb,
                    platform: platform.into(),
                    ..Default::default()
                });
            }
        }
    }

    // Pattern B: IG carousel / post (div.download-items)
    if let Ok(sel) = Selector::parse("div.download-items") {
        let items: Vec<MediaItem> = doc
            .select(&sel)
            .filter_map(|el| {
                let thumb = el
                    .select(&Selector::parse(".download-items__thumb img").unwrap())
                    .next()
                    .and_then(|i| i.value().attr("src"))
                    .unwrap_or("")
                    .to_string();
                let btn_span = el
                    .select(&Selector::parse(".download-items__btn span").unwrap())
                    .next()
                    .map(|s| s.text().collect::<String>().to_lowercase())
                    .unwrap_or_default();
                let href = el
                    .select(&Selector::parse(".download-items__btn a").unwrap())
                    .next()
                    .and_then(|a| a.value().attr("href"))
                    .unwrap_or("")
                    .to_string();
                let is_photo = btn_span.contains("photo") || btn_span.contains("ảnh");
                let (kind, url) = if is_photo {
                    ("image", thumb.clone())
                } else {
                    ("video", href)
                };
                if url.is_empty() { None } else {
                    Some(MediaItem { kind: kind.to_string(), url })
                }
            })
            .collect();
        if items.len() == 1 {
            let it = items.into_iter().next().unwrap();
            return Some(MediaInfo {
                media_type: it.kind.clone(),
                url: Some(it.url),
                title: desc,
                thumbnail: figure_thumb,
                platform: platform.into(),
                ..Default::default()
            });
        }
        if !items.is_empty() {
            let thumb = items[0].url.clone();
            return Some(MediaInfo {
                media_type: "carousel".into(),
                items: Some(items),
                title: desc,
                thumbnail: thumb,
                platform: platform.into(),
                ..Default::default()
            });
        }
    }

    // Pattern C: div.card (FB single)
    if let Ok(sel) = Selector::parse("div.card") {
        let cards: Vec<MediaItem> = doc
            .select(&sel)
            .filter_map(|el| {
                let a = el.select(&Selector::parse(".card-body a, a").unwrap()).next()?;
                let url = a.value().attr("href").unwrap_or("").to_string();
                if url.is_empty() || url == "#" { return None; }
                let txt = a.text().collect::<String>().to_lowercase();
                let kind = if txt.contains("photo") || txt.contains("ảnh") { "image" } else { "video" };
                Some(MediaItem { kind: kind.to_string(), url })
            })
            .collect();
        if cards.len() == 1 {
            let it = cards.into_iter().next().unwrap();
            return Some(MediaInfo {
                media_type: it.kind.clone(),
                url: Some(it.url),
                title: desc,
                thumbnail: figure_thumb,
                platform: platform.into(),
                ..Default::default()
            });
        }
        if !cards.is_empty() {
            return Some(MediaInfo {
                media_type: "carousel".into(),
                items: Some(cards),
                title: desc,
                thumbnail: figure_thumb,
                platform: platform.into(),
                ..Default::default()
            });
        }
    }

    // Pattern D: fallback 1 anchor đầu tiên
    if let Some(a) = doc
        .select(&Selector::parse("a[href^='http']").unwrap())
        .next()
    {
        let url = a.value().attr("href").unwrap_or("").to_string();
        let txt = a.text().collect::<String>().to_lowercase();
        let kind = if txt.contains("photo") || txt.contains("ảnh") { "image" } else { "video" };
        return Some(MediaInfo {
            media_type: kind.to_string(),
            url: Some(url),
            title: desc,
            thumbnail: figure_thumb,
            platform: platform.into(),
            ..Default::default()
        });
    }

    None
}
