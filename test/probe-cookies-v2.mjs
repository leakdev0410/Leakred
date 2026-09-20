// Mimic yt-dlp: multiple requests to harvest all 4 anonymous cookies
let cookies = "";

async function addCookies(res) {
  const setCookies = res.headers.getSetCookie?.() || [];
  for (const sc of setCookies) {
    const [pair] = sc.split(";");
    const [name, value] = pair.split("=");
    if (name && value) {
      // Replace existing cookie or add new
      const re = new RegExp(`(?:^|;\\s*)${name}=[^;]+`);
      cookies = cookies.replace(re, "").trim();
      cookies = cookies ? `${cookies}; ${name}=${value}` : `${name}=${value}`;
    }
  }
}

const COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-us,en;q=0.5",
  "Sec-Fetch-Mode": "navigate",
};

// Step 1: Multiple GETs to instagram.com to collect all cookies
for (let i = 0; i < 3; i++) {
  const res = await fetch("https://www.instagram.com/", {
    headers: { ...COMMON_HEADERS, Cookie: cookies },
    redirect: "follow",
  });
  await addCookies(res);
  await res.text();
  console.log(`After GET #${i+1}:`, cookies);
}

console.log('\n=== Step 2: GET /p/Dcv9Bz7MSYQ with all 4 cookies ===');
const page = await fetch("https://www.instagram.com/p/Dcv9Bz7MSYQ", {
  headers: { ...COMMON_HEADERS, Cookie: cookies },
  redirect: "follow",
});
const html = await page.text();
console.log('  status:', page.status, 'size:', html.length);

const ogV = html.match(/<meta[^>]*property=["']og:video["'][^>]*content=["'](https?:[^"']+)["']/i);
const ogI = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["'](https?:[^"']+)["']/i);
const ogT = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
console.log('  og:video:', ogV?.[1]?.slice(0, 200) || 'NONE');
console.log('  og:image:', ogI?.[1]?.slice(0, 200) || 'NONE');
console.log('  og:title:', ogT?.[1]?.slice(0, 100) || 'NONE');

const mp4 = [...html.matchAll(/https?:[^"'\\\s]+\.mp4[^"'\\\s]*/g)];
console.log('  mp4 count:', mp4.length);
mp4.slice(0, 5).forEach((m, i) => console.log('  mp4 ' + (i+1) + ':', m[0].slice(0, 200)));

// Look for video_url in data-sjs
const sjsBlocks = [...html.matchAll(/<script[^>]*data-sjs[^>]*>([\s\S]+?)<\/script>/g)];
console.log('  data-sjs blocks:', sjsBlocks.length);
let foundVideo = false;
for (const block of sjsBlocks) {
  const m = block[1].match(/"video_url"\s*:\s*"(https?:[^"]+)"/);
  if (m) {
    console.log('  VIDEO_URL in sjs:', m[1].slice(0, 200));
    foundVideo = true;
    break;
  }
}
if (!foundVideo) console.log('  No video_url in data-sjs');

// Look for playback_url
const playback = [...html.matchAll(/playback_url[^"]*"([^"]+)"/g)];
console.log('  playback_url count:', playback.length);
playback.slice(0, 2).forEach((m, i) => console.log('  ' + (i+1) + '.', m[1].slice(0, 200)));

// Look for DASH manifest
const dash = html.match(/dash_manifest[^"]*"([^"]+)"/);
console.log('  dash_manifest:', dash?.[1]?.slice(0, 100) || 'NONE');