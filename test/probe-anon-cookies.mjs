// Test yt-dlp's anonymous cookie technique
async function fetchWithRedirect(url, opts) {
  const res = await fetch(url, { ...opts, redirect: "manual" });
  const setCookies = res.headers.getSetCookie?.() || [];
  let cookies = opts.headers?.Cookie || "";
  for (const sc of setCookies) {
    const [pair] = sc.split(";");
    const [name, value] = pair.split("=");
    if (name && value && !cookies.includes(name + "=")) {
      cookies += cookies ? "; " : "";
      cookies += name + "=" + value;
    }
  }
  return { status: res.status, location: res.headers.get("location"), cookies, setCookies, body: res.status === 200 ? await res.text() : "" };
}

console.log('=== Step 1: GET instagram.com to harvest cookies ===');
const init = await fetchWithRedirect("https://www.instagram.com/", {
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-us,en;q=0.5",
    "Sec-Fetch-Mode": "navigate",
  },
});
console.log('  status:', init.status);
console.log('  cookies:', init.cookies);

console.log('\n=== Step 2: GET /p/Dcv9Bz7MSYQ with cookies ===');
const page = await fetchWithRedirect("https://www.instagram.com/p/Dcv9Bz7MSYQ", {
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-us,en;q=0.5",
    "Sec-Fetch-Mode": "navigate",
    "Cookie": init.cookies,
  },
});
console.log('  status:', page.status);
console.log('  body size:', page.body.length);

// Look for video URLs
const ogV = page.body.match(/<meta[^>]*property=["']og:video["'][^>]*content=["'](https?:[^"']+)["']/i);
const ogI = page.body.match(/<meta[^>]*property=["']og:image["'][^>]*content=["'](https?:[^"']+)["']/i);
const ogT = page.body.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
console.log('  og:video:', ogV?.[1]?.slice(0, 200) || 'NONE');
console.log('  og:image:', ogI?.[1]?.slice(0, 200) || 'NONE');
console.log('  og:title:', ogT?.[1]?.slice(0, 100) || 'NONE');

const mp4 = [...page.body.matchAll(/https?:[^"'\\\s]+\.mp4[^"'\\\s]*/g)];
console.log('  mp4 count:', mp4.length);
mp4.slice(0, 3).forEach((m, i) => console.log('  mp4 ' + (i+1) + ':', m[0].slice(0, 200)));

console.log('\n=== Step 3: GET get_ruling_for_content ===');
const targetId = '3976665401302001168';
const ruling = await fetchWithRedirect(`https://www.instagram.com/api/v1/web/get_ruling_for_content/?content_type=MEDIA&target_id=${targetId}`, {
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-us,en;q=0.5",
    "Sec-Fetch-Mode": "navigate",
    "X-IG-App-ID": "936619743392459",
    "X-ASBD-ID": "359341",
    "X-IG-WWW-Claim": "0",
    "Origin": "https://www.instagram.com",
    "Cookie": init.cookies,
  },
});
console.log('  status:', ruling.status);
console.log('  body:', ruling.body.slice(0, 200));