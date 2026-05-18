use serde::Serialize;

#[derive(Serialize, Debug, Clone)]
pub struct MediaItem {
    pub kind: String, // "image" | "video"
    pub url: String,
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct MediaInfo {
    #[serde(rename = "type")]
    pub media_type: String, // "video" | "image" | "carousel"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<MediaItem>>,
    pub title: String,
    pub author: String,
    #[serde(rename = "authorAvatar")]
    pub author_avatar: String,
    pub thumbnail: String,
    pub platform: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<u64>,
}
