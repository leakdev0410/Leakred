# Leakred Cloudflare Worker

Worker trung gian cho Leakred — port các strategies trích xuất video/ảnh của
**yt-dlp** (yt-dlp/yt-dlp) sang JavaScript chạy trên Cloudflare edge. Kèm hỗ trợ
cookie session do user cung cấp để bypass giới hạn anonymous của IG/FB.

**Free tier: 100k request/ngày, 10ms CPU/request.**

## Tại sao cần Worker?

yt-dlp là CLI Python — không nhúng được vào web. Worker port logic của nó (shortcode
→ media_id conversion, GraphQL query với LSD token, `data-sjs` parsing, FB playable_url
extraction) sang JavaScript chạy ở Cloudflare edge, gần user, không bị CORS.

## Routes

```
GET  /                          Health check
GET  /api/instagram?url=...     Trả JSON media cho link Instagram
GET  /api/facebook?url=...      Trả JSON media cho link Facebook
GET  /api/tiktok?url=...        Passthrough TikWM (đã ổn định)
```

### Headers frontend gửi kèm

| Header | Mục đích |
|---|---|
| `Authorization: Bearer <token>` | (optional) nếu đã set secret `WORKER_TOKEN` |
| `X-IG-Cookie: sessionid=...` | (optional) Instagram session cookies |
| `X-FB-Cookie: c_user=...; xs=...` | (optional) Facebook session cookies |

### Response mẫu

```json
{ "ok": true, "platform": "instagram", "type": "video",
  "url": "https://cdn.example/video.mp4",
  "title": "...", "thumbnail": "https://...",
  "author": "...", "authorAvatar": "https://...",
  "duration": 30.5, "source": "graphql" }
```

```json
{ "ok": false, "error": "Không lấy được media IG (cookie có thể đã hết hạn...)" }
```

## Triển khai (5 phút)

### Yêu cầu

- Tài khoản Cloudflare (free)
- Node 18+ (chỉ cần khi dùng wrangler CLI)
- `wrangler` CLI: `npm install -g wrangler`

### Bước 1 — Login

```bash
wrangler login
```

### Bước 2 — Tuỳ chọn: tạo KV cache (khuyến nghị)

```bash
wrangler kv namespace create CACHE
# Copy `id` trong output, dán vào wrangler.toml (bỏ comment block kv_namespaces)
```

### Bước 3 — Tuỳ chọn: bảo vệ bằng token

Nếu không muốn ai cũng có thể gọi URL Worker:

```bash
wrangler secret put WORKER_TOKEN
# Nhập token, ví dụ: "leakred-abc123-xyz"
```

Sau đó frontend sẽ gửi header `Authorization: Bearer leakred-abc123-xyz`.

### Bước 4 — Deploy

```bash
cd worker
wrangler deploy
```

Wrangler sẽ in URL Worker, ví dụ:
`https://leakred-downloader.<your-subdomain>.workers.dev`

### Bước 5 — Test

```bash
curl 'https://leakred-downloader.<your-subdomain>.workers.dev/'
curl 'https://leakred-downloader.<your-subdomain>.workers.dev/api/tiktok?url=https://www.tiktok.com/@scout2015/video/6718335390845095173'
```

## Cấu hình frontend

Mở `script.js`, tìm:

```js
const CORS_PROXIES = [
  (u) => "https://corsproxy.io/?" + encodeURIComponent(u),
  ...
];
const PROXY_FETCH_TIMEOUT_MS = 8000;
const fetchViaProxies = window.LeakredProxyFetch.createProxyFetcher({...});
```

Thêm ngay sau đó:

```js
// Worker endpoint — đổi URL thành Worker của bạn sau khi deploy.
const WORKER_BASE = "https://leakred-downloader.<your-subdomain>.workers.dev";
// Nếu bạn đã set WORKER_TOKEN, paste vào đây (frontend không persist):
// const WORKER_TOKEN = "leakred-abc123-xyz";
```

Rồi trong `fetchInstagram` / `fetchFacebook` thay logic hiện tại bằng:

```js
async function fetchViaWorker(platform, url) {
  const res = await fetch(`${WORKER_BASE}/api/${platform}?url=${encodeURIComponent(url)}`, {
    headers: WORKER_TOKEN ? { "Authorization": "Bearer " + WORKER_TOKEN } : {},
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "Worker failed");
  return j;
}
```

Giữ nguyên fallback `fetchViaProxies` cho trường hợp Worker lỗi.

## Tuỳ chọn nâng cao

### Custom domain

```bash
wrangler routes put "download.yourdomain.com/*" --zone-id <zone-id>
```

Rồi đổi `WORKER_BASE` thành `https://download.yourdomain.com`.

### Giới hạn CPU

Worker free có 10ms CPU/request. Logic hiện tại đủ nhẹ. Nếu thấy
`CPU time limit exceeded`, kiểm tra `wrangler tail` và tối ưu regex/parsing.

### Khi IG/FB đổi cấu trúc

Worker port strategies từ yt-dlp (`yt-dlp/yt-dlp`). Nếu IG/FB đổi `doc_id`,
header, hoặc cấu trúc response:
- Cập nhật `igStrategyGraphql` / `fbStrategyPageParse` trong `index.js`
- Có thể tham khảo yt-dlp mới nhất: https://github.com/yt-dlp/yt-dlp/tree/master/yt_dlp/extractor
- Sau đó `wrangler deploy` lại

### Cấu hình `wrangler.toml` nâng cao

```toml
[vars]
STRATEGY_TIMEOUT_MS = "8000"   # tăng nếu IG/FB chậm
LOG_LEVEL = "60"                # debug chi tiết
```

## Lưu ý thực tế

> ⚠️ Meta liên tục chặn keyless access. Worker cải thiện UX (không phải chờ
> 16-24s rồi mới biết fail) nhưng **tỉ lệ thành công vẫn phụ thuộc vào các
> backend public**. Nếu sau vài tháng tất cả backend chết hẳn, giải pháp
> dài hạn là self-host Cobalt hoặc yt-dlp API trên HuggingFace Spaces / fly.io
> và đổi `WORKER_BASE` trỏ vào đó. Cấu trúc response không đổi, frontend
> không cần sửa.

## Lấy cookie IG/FB (optional, khuyến nghị)

Một số video/ảnh IG/FB yêu cầu đăng nhập mới xem được. Khi đó Worker cần
session cookie của bạn.

### Instagram (`sessionid`)

1. Mở `instagram.com` trong Chrome, **đăng nhập** tài khoản của bạn
2. F12 → tab **Application** → **Cookies** → `https://www.instagram.com`
3. Tìm dòng `sessionid`, copy **Value** (chuỗi dài ~50 ký tự)
4. Paste vào ô "Instagram" trên trang web: `sessionid=<giá-trị-vừa-copy>`

### Facebook (`c_user` + `xs`)

1. Mở `facebook.com`, **đăng nhập**
2. F12 → **Application** → **Cookies** → `https://www.facebook.com`
3. Copy 2 giá trị: `c_user` và `xs`
4. Paste dạng: `c_user=123456; xs=abc:def...`

### Cookie không bị lưu

- Cookie gửi qua header `X-IG-Cookie` / `X-FB-Cookie`
- Frontend **không persist** xuống localStorage / sessionStorage
- Worker **không lưu** cookie (chỉ forward đến IG/FB trong request)
- Đóng tab = mất cookie, phải paste lại lần sau

### Khi nào nên dùng cookie?

- IG/FB cá nhân bạn đăng tải
- Tài khoản bạn follow (Reel, Story)
- Private group / page bạn là thành viên

**Không nên** dùng cookie của tài khoản khác — vi phạm TOS của Meta.