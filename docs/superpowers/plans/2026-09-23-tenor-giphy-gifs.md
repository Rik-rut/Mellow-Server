# Tenor/Giphy GIF Inline Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user pastes a Tenor or Giphy link, render it inline as an animated GIF instead of a bare URL.

**Architecture:** Add Tenor/Giphy detection to `TextFormat.detectProvider` so existing `.embed-slot` markup is produced automatically. A new focused server module (`server/gif-embed.js`) holds pure host/oEmbed helpers; a new same-origin endpoint `GET /api/embed/gif` resolves share links to direct media URLs via provider oEmbed. The client (`public/js/embed.js`) renders the returned URL as an `<img>`. No iframe means no CSP changes.

**Tech Stack:** Vanilla JS (UMD modules with `module.exports` for testability), Node `node:test`, Express (`server.js`), `fetch` (Node 22 built-in).

## Global Constraints

- No changes to the `Content-Security-Policy` header in `server.js`. GIFs must render via `<img>` (covered by existing `img-src 'self' data: blob: https:`) and same-origin `fetch` (covered by `connect-src 'self'`). Do not add `frame-src` origins.
- Do not change the Instagram-only `isEmbedAllowedHost` (`server.js:914-919`); keep a separate Tenor/Giphy allowlist.
- Reuse the existing `tooManyAttempts(key, max, windowMs)` rate limiter (`server.js:464`).
- Follow the existing UMD pattern in `public/js/*.js` (`text-format.js:1-8`, `embed.js:1-8`).
- Windows PowerShell 5.1 environment.
- Tests live in `tests/*.test.js` and run with `npm test` (`node --test "tests/*.test.js"`).

---

### Task 1: Detect Tenor/Giphy URLs in the text formatter

**Files:**
- Modify: `public/js/text-format.js:31-77` (`detectProvider`)
- Test: `tests/text-format-gif.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `detectProvider(url)` returns `{ provider: 'tenor'|'giphy', videoId: <string|null>, mediaType: 'gif' }` for Tenor/Giphy page and direct-media URLs; unchanged behavior for all other inputs. `tokenizeMessage` (unchanged) therefore emits `token.provider` values `'tenor'`/`'giphy'`.

- [ ] **Step 1: Write the failing test**

Create `tests/text-format-gif.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const TextFormat = require('../public/js/text-format.js');

test('detects Tenor share links', () => {
  const r = TextFormat.detectProvider('https://tenor.com/view/dance-cat-gif-12345678');
  assert.strictEqual(r.provider, 'tenor');
  assert.strictEqual(r.mediaType, 'gif');
});

test('detects Tenor locale share links', () => {
  const r = TextFormat.detectProvider('https://tenor.com/en-US/view/dance-cat-gif-12345678');
  assert.strictEqual(r.provider, 'tenor');
});

test('detects Giphy gifs links', () => {
  const r = TextFormat.detectProvider('https://giphy.com/gifs/funny-cat-abc123XYZ');
  assert.strictEqual(r.provider, 'giphy');
  assert.strictEqual(r.mediaType, 'gif');
});

test('detects Giphy media links', () => {
  const r = TextFormat.detectProvider('https://giphy.com/media/abc123XYZ');
  assert.strictEqual(r.provider, 'giphy');
});

test('detects direct media CDN links', () => {
  assert.strictEqual(TextFormat.detectProvider('https://media.tenor.com/abc/tenor.gif').provider, 'tenor');
  assert.strictEqual(TextFormat.detectProvider('https://media.giphy.com/media/abc/giphy.gif').provider, 'giphy');
  assert.strictEqual(TextFormat.detectProvider('https://i.giphy.com/abc.gif').provider, 'giphy');
});

test('does not misclassify unrelated URLs', () => {
  assert.strictEqual(TextFormat.detectProvider('https://example.com/view/x-1').provider, null);
  assert.strictEqual(TextFormat.detectProvider('https://notgiphy.com/gifs/x').provider, null);
});

test('tokenizeMessage tags Giphy link', () => {
  const tokens = TextFormat.tokenizeMessage('nice https://giphy.com/gifs/cat-abc123XYZ please');
  const urlToken = tokens.find(t => t.type === 'url');
  assert.strictEqual(urlToken.provider, 'giphy');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/text-format-gif.test.js`
Expected: FAIL — `provider` is `null` for the Tenor/Giphy URLs.

- [ ] **Step 3: Add the detection branches**

In `public/js/text-format.js`, inside `detectProvider`, add the following immediately before the final `return { provider: null, videoId: null, mediaType: null };`:

```js
    // Tenor
    if ((m = /(?:www\.)?tenor\.com\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?view\/[^/?#]*-(\d{5,30})/i.exec(url))) {
      return { provider: 'tenor', videoId: m[1], mediaType: 'gif' };
    }
    if ((m = /(?:www\.)?tenor\.com\/(\d{5,30})\.gif/i.exec(url))) {
      return { provider: 'tenor', videoId: m[1], mediaType: 'gif' };
    }
    if (/media\.tenor\.com\//i.test(url)) {
      return { provider: 'tenor', videoId: null, mediaType: 'gif' };
    }

    // Giphy
    if ((m = /(?:www\.)?giphy\.com\/gifs\/(?:[^/?#]*?-)?([A-Za-z0-9]{5,40})(?:[/?#]|$)/.exec(url))) {
      return { provider: 'giphy', videoId: m[1], mediaType: 'gif' };
    }
    if ((m = /(?:www\.)?giphy\.com\/media\/([A-Za-z0-9]{5,40})/.exec(url))) {
      return { provider: 'giphy', videoId: m[1], mediaType: 'gif' };
    }
    if (/(?:media\d*|i)\.giphy\.com\//i.test(url)) {
      return { provider: 'giphy', videoId: null, mediaType: 'gif' };
    }
```

Placement matters: these must come after the YouTube/TikTok/Instagram/Facebook checks and before the default return.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/text-format-gif.test.js`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Verify no regressions in the full suite**

Run: `npm test`
Expected: PASS (or "no tests" only for unrelated files; this file passes).

- [ ] **Step 6: Commit**

```bash
git add public/js/text-format.js tests/text-format-gif.test.js
git commit -m "feat: detect Tenor and Giphy links in text formatter"
```

---

### Task 2: Add the pure GIF host/oEmbed helper module

**Files:**
- Create: `server/gif-embed.js`
- Test: `tests/gif-embed.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (all exported from `server/gif-embed.js`):
  - `detectGifProvider(host)` → `'tenor' | 'giphy' | null`
  - `isAllowedGifMediaHost(host)` → boolean
  - `buildOembedUrl(url)` → `string | null` (provider oEmbed endpoint with `?url=` encoded)
  - `extractMediaUrl(oembed)` → `string | null` (validated `https:` media URL on an allowed CDN host)

- [ ] **Step 1: Write the failing test**

Create `tests/gif-embed.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const Gif = require('../server/gif-embed.js');

test('detectGifProvider recognizes providers and media hosts', () => {
  assert.strictEqual(Gif.detectGifProvider('tenor.com'), 'tenor');
  assert.strictEqual(Gif.detectGifProvider('www.tenor.com'), 'tenor');
  assert.strictEqual(Gif.detectGifProvider('media.tenor.com'), 'tenor');
  assert.strictEqual(Gif.detectGifProvider('giphy.com'), 'giphy');
  assert.strictEqual(Gif.detectGifProvider('media.giphy.com'), 'giphy');
  assert.strictEqual(Gif.detectGifProvider('i.giphy.com'), 'giphy');
  assert.strictEqual(Gif.detectGifProvider('evil.com'), null);
  assert.strictEqual(Gif.detectGifProvider('notgiphy.com'), null);
  assert.strictEqual(Gif.detectGifProvider('giphy.com.evil.com'), null);
});

test('isAllowedGifMediaHost only allows media CDN hosts', () => {
  assert.strictEqual(Gif.isAllowedGifMediaHost('media.tenor.com'), true);
  assert.strictEqual(Gif.isAllowedGifMediaHost('media.giphy.com'), true);
  assert.strictEqual(Gif.isAllowedGifMediaHost('media3.giphy.com'), true);
  assert.strictEqual(Gif.isAllowedGifMediaHost('i.giphy.com'), true);
  assert.strictEqual(Gif.isAllowedGifMediaHost('giphy.com'), false);
  assert.strictEqual(Gif.isAllowedGifMediaHost('www.giphy.com'), false);
  assert.strictEqual(Gif.isAllowedGifMediaHost('tenor.com'), false);
  assert.strictEqual(Gif.isAllowedGifMediaHost('evil.com'), false);
  assert.strictEqual(Gif.isAllowedGifMediaHost('giphy.com.evil.com'), false);
});

test('buildOembedUrl builds provider endpoints and rejects unknown hosts', () => {
  assert.ok(Gif.buildOembedUrl('https://tenor.com/view/x-12345678').startsWith('https://tenor.com/oembed?url='));
  assert.ok(Gif.buildOembedUrl('https://giphy.com/gifs/x-abc123XYZ').startsWith('https://giphy.com/services/oembed?url='));
  assert.strictEqual(Gif.buildOembedUrl('https://evil.com/x'), null);
  assert.strictEqual(Gif.buildOembedUrl('http://giphy.com/gifs/x'), null);
  assert.strictEqual(Gif.buildOembedUrl('not a url'), null);
});

test('extractMediaUrl returns only allowed https media URLs', () => {
  assert.strictEqual(
    Gif.extractMediaUrl({ url: 'https://media.giphy.com/media/abc/giphy.gif' }),
    'https://media.giphy.com/media/abc/giphy.gif'
  );
  assert.strictEqual(
    Gif.extractMediaUrl({ thumbnail_url: 'https://media.tenor.com/abc/tenor.gif' }),
    'https://media.tenor.com/abc/tenor.gif'
  );
  assert.strictEqual(Gif.extractMediaUrl({ url: 'https://evil.com/x.gif' }), null);
  assert.strictEqual(Gif.extractMediaUrl({ url: 'http://media.giphy.com/x.gif' }), null);
  assert.strictEqual(Gif.extractMediaUrl(null), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/gif-embed.test.js`
Expected: FAIL with `Cannot find module '../server/gif-embed.js'`.

- [ ] **Step 3: Create the module**

Create `server/gif-embed.js`:

```js
'use strict';

const TENOR_PAGE_DOMAINS = ['tenor.com'];
const GIPHY_PAGE_DOMAINS = ['giphy.com'];
const TENOR_MEDIA_DOMAINS = ['media.tenor.com'];
const GIPHY_MEDIA_SUFFIX = 'giphy.com';

function hostMatches(host, domains) {
  const h = String(host || '').toLowerCase();
  return domains.some(d => h === d || h.endsWith('.' + d));
}

function detectGifProvider(host) {
  if (hostMatches(host, TENOR_PAGE_DOMAINS)) return 'tenor';
  if (hostMatches(host, GIPHY_PAGE_DOMAINS)) return 'giphy';
  return null;
}

// Media URLs must live on a subdomain of the provider CDN, never the bare
// page domain (a bare giphy.com/tenor.com URL is a web page, not an image).
function isAllowedGifMediaHost(host) {
  const h = String(host || '').toLowerCase();
  if (hostMatches(h, TENOR_MEDIA_DOMAINS)) return true;
  return h.endsWith('.' + GIPHY_MEDIA_SUFFIX);
}

function buildOembedUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const provider = detectGifProvider(parsed.hostname);
  if (provider === 'tenor') return 'https://tenor.com/oembed?url=' + encodeURIComponent(url);
  if (provider === 'giphy') return 'https://giphy.com/services/oembed?url=' + encodeURIComponent(url);
  return null;
}

function extractMediaUrl(oembed) {
  if (!oembed || typeof oembed !== 'object') return null;
  const candidates = [oembed.url, oembed.thumbnail_url];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'https:' && isAllowedGifMediaHost(parsed.hostname)) {
        return parsed.toString();
      }
    } catch (_) {}
  }
  return null;
}

module.exports = { detectGifProvider, isAllowedGifMediaHost, buildOembedUrl, extractMediaUrl };
```

Note: `detectGifProvider('giphy.com')` is `'giphy'` (page host) while `isAllowedGifMediaHost('giphy.com')` is `false` (page host, not media). Giphy serves actual media from subdomains (`media.giphy.com`, `media3.giphy.com`, `i.giphy.com`), so only those pass the media check. `hostMatches` is equal-or-subdomain, and the suffix attack `giphy.com.evil.com` fails both checks because it neither equals nor ends with `.giphy.com` / `.tenor.com`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/gif-embed.test.js`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/gif-embed.js tests/gif-embed.test.js
git commit -m "feat: add Tenor/Giphy oEmbed helper module"
```

---

### Task 3: Add the `/api/embed/gif` endpoint

**Files:**
- Modify: `server.js` (top requires; new route after `app.get('/api/embed/video', ...)` which ends at `server.js:1173`)

**Interfaces:**
- Consumes: `GifEmbed` from Task 2; existing `tooManyAttempts` (`server.js:464`) and `clientIp` (`server.js:486`).
- Produces: `GET /api/embed/gif?url=<encoded>` → `200 { image, title, width, height }` on success; `400` for missing/invalid/unsupported URL; `429` when rate-limited; `502` when resolution fails. The client (Task 4) depends on the `image` field.

- [ ] **Step 1: Require the helper module**

Near the other `require('./server/...')` lines at the top of `server.js` (after `const ReadState = require('./server/read-state.js');` at `server.js:92`), add:

```js
const GifEmbed = require('./server/gif-embed.js');
```

- [ ] **Step 2: Add the endpoint and cache helper**

Immediately after the closing of the `/api/embed/video` route (the `});` at `server.js:1173`), insert:

```js
/* ── Tenor/Giphy GIF resolution (oEmbed → direct media URL) ──────────── */
const gifPreviewCache = new Map();

function cacheGifPreview(key, result) {
  if (gifPreviewCache.size > 500) {
    gifPreviewCache.delete(gifPreviewCache.keys().next().value);
  }
  gifPreviewCache.set(key, result);
}

app.get('/api/embed/gif', async (req, res) => {
  const targetUrl = (req.query.url || '').trim();
  if (!targetUrl) return res.status(400).json({ error: 'url query param required' });
  if (tooManyAttempts(`gif:${clientIp(req)}`, 120, 60 * 1000)) {
    return res.status(429).json({ error: 'Too many GIF requests. Try again later.' });
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (_) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  if (parsed.protocol !== 'https:' || !GifEmbed.detectGifProvider(parsed.hostname)) {
    return res.status(400).json({ error: 'Domain not supported for GIF preview' });
  }

  if (gifPreviewCache.has(targetUrl)) {
    return res.json(gifPreviewCache.get(targetUrl));
  }

  // Direct CDN link: no oEmbed lookup needed
  if (GifEmbed.isAllowedGifMediaHost(parsed.hostname)) {
    const result = { image: targetUrl, title: '', width: null, height: null };
    cacheGifPreview(targetUrl, result);
    return res.json(result);
  }

  try {
    const oembedUrl = GifEmbed.buildOembedUrl(targetUrl);
    if (!oembedUrl) return res.status(400).json({ error: 'Unsupported GIF URL' });
    const oembedRes = await fetch(oembedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MellowGif/1.0)' },
      signal: AbortSignal.timeout(5000)
    });
    if (!oembedRes.ok) return res.status(502).json({ error: 'Failed to resolve GIF' });
    const data = await oembedRes.json();
    const image = GifEmbed.extractMediaUrl(data);
    if (!image) return res.status(502).json({ error: 'No GIF media found' });

    const result = {
      image,
      title: typeof data.title === 'string' ? data.title.slice(0, 200) : '',
      width: Number.isFinite(data.width) ? data.width : null,
      height: Number.isFinite(data.height) ? data.height : null
    };
    cacheGifPreview(targetUrl, result);
    res.json(result);
  } catch (_) {
    res.status(502).json({ error: 'Unable to resolve GIF' });
  }
});
```

- [ ] **Step 3: Syntax-check the server**

```powershell
node --check server.js
```

Expected: no output, exit code 0.

- [ ] **Step 4: Verify the helper is required and the route exists**

```powershell
Select-String -Path server.js -Pattern "gif-embed|/api/embed/gif"
```

Expected: at least two matches (the require line and the route definition).

- [ ] **Step 5: Manual smoke test**

Start the server (`npm start`) and, in a browser or with `curl.exe`, hit a known Giphy link:

```powershell
curl.exe -k "https://localhost:6767/api/embed/gif?url=https%3A%2F%2Fgiphy.com%2Fgifs%2Ffunny-cat-3o7abKhOpu0NwenH3O"
```

Expected: JSON containing an `image` URL on a `*.giphy.com` host. Also verify an unsupported URL returns `400`:

```powershell
curl.exe -k "https://localhost:6767/api/embed/gif?url=https%3A%2F%2Fexample.com%2Fx"
```

Expected: `{"error":"Domain not supported for GIF preview"}`.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: add /api/embed/gif oEmbed endpoint for Tenor and Giphy"
```

---

### Task 4: Render GIFs inline on the client

**Files:**
- Modify: `public/js/embed.js` (`getProviderMeta` `embed.js:41-79`; `createUnifiedCard` `embed.js:81-353`)
- Modify: `public/css/style.css` (after the provider theme block, ~`style.css:1717` and after `.embed-facebook .embed-card-badge i`, ~`style.css:1758`)
- Modify: `public/index.html:967-968` (cache-busters)

**Interfaces:**
- Consumes: `GET /api/embed/gif` from Task 3; `slot` attributes `data-provider`, `data-url` produced by `main.js:3844`.
- Produces: end-user behavior only.

- [ ] **Step 1: Add provider metadata**

In `public/js/embed.js`, inside `getProviderMeta`, add before the `default:` case:

```js
      case 'tenor':
        return {
          name: 'Tenor',
          iconClass: 'ph-gif',
          typeLabel: 'GIF',
          themeClass: 'embed-tenor'
        };
      case 'giphy':
        return {
          name: 'Giphy',
          iconClass: 'ph-gif',
          typeLabel: 'GIF',
          themeClass: 'embed-giphy'
        };
```

- [ ] **Step 2: Add the direct-media helper**

In `public/js/embed.js`, inside the factory function, immediately before `function getProviderMeta(provider, mediaType) {`, add:

```js
  function isDirectGifMediaUrl(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === 'media.tenor.com'
        || /^(?:media\d*|i)\.giphy\.com$/.test(host);
    } catch (_) {
      return false;
    }
  }
```

- [ ] **Step 3: Add the render branch**

In `public/js/embed.js`, inside `createUnifiedCard`, add a new branch after the Instagram branch (after the `} else if (provider === 'facebook') {` block ends, or before it — either is fine as long as it is a sibling `else if`). Insert:

```js
    } else if (provider === 'tenor' || provider === 'giphy') {
      const gifWrap = document.createElement('div');
      gifWrap.className = 'embed-gif';
      const loading = document.createElement('div');
      loading.className = 'embed-gif-placeholder';
      loading.textContent = 'Loading GIF...';
      gifWrap.appendChild(loading);
      body.appendChild(gifWrap);

      function showGif(src, title) {
        gifWrap.innerHTML = '';
        const img = document.createElement('img');
        img.className = 'embed-gif-image';
        img.loading = 'lazy';
        img.alt = title || ((provider === 'tenor' ? 'Tenor' : 'Giphy') + ' GIF');
        img.src = src;
        img.onerror = function () {
          gifWrap.innerHTML = '<div class="embed-gif-placeholder">GIF unavailable</div>';
        };
        gifWrap.appendChild(img);
      }

      if (isDirectGifMediaUrl(url)) {
        showGif(url, '');
      } else if (typeof fetch !== 'undefined') {
        fetch('/api/embed/gif?url=' + encodeURIComponent(url))
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (data && data.image) showGif(data.image, data.title);
            else gifWrap.innerHTML = '<div class="embed-gif-placeholder">GIF unavailable</div>';
          })
          .catch(function () {
            gifWrap.innerHTML = '<div class="embed-gif-placeholder">GIF unavailable</div>';
          });
      }
    }
```

- [ ] **Step 4: Add the CSS**

In `public/css/style.css`, after the existing `.embed-card.embed-facebook { border-left-color: #1877f2; }` block (~line 1715-1717), add:

```css
.embed-card.embed-tenor {
  border-left-color: #ff6b35;
}
.embed-card.embed-giphy {
  border-left-color: #00cc7a;
}
```

After the existing `.embed-facebook .embed-card-badge i { color: #1877f2; }` block (~line 1756-1758), add:

```css
.embed-tenor .embed-card-badge i {
  color: #ff6b35;
}
.embed-giphy .embed-card-badge i {
  color: #00cc7a;
}
```

Then add the GIF media styles at the end of the embed section (after the Instagram responsive overrides, ~line 2060):

```css
/* GIF embeds (Tenor / Giphy) */
.embed-gif {
  display: block;
  line-height: 0;
  background: rgba(0, 0, 0, 0.2);
  text-align: center;
}
.embed-gif-image {
  display: block;
  margin: 0 auto;
  max-width: 100%;
  max-height: 400px;
  width: auto;
  height: auto;
}
.embed-gif-placeholder {
  padding: 24px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}
```

- [ ] **Step 5: Bump cache-busters**

In `public/index.html`, change:

```html
  <script src="/js/text-format.js?v=1.2.1"></script>
  <script src="/js/embed.js?v=1.2.2"></script>
```

to:

```html
  <script src="/js/text-format.js?v=1.2.2"></script>
  <script src="/js/embed.js?v=1.2.3"></script>
```

- [ ] **Step 6: Syntax-check the client bundles**

```powershell
node --check public/js/embed.js
node --check public/js/text-format.js
```

Expected: no output, exit code 0 for both.

- [ ] **Step 7: Manual verification (browser)**

Start the server, open the app, and send a message containing a Tenor share link and a Giphy share link. Expected:
- Each link renders a card with a Tenor/Giphy header and an inline animated GIF.
- A direct `https://media.giphy.com/media/<id>/giphy.gif` URL renders immediately without a visible loading delay.
- No CSP errors in the console; no iframe is created.

- [ ] **Step 8: Commit**

```bash
git add public/js/embed.js public/css/style.css public/index.html
git commit -m "feat: render Tenor and Giphy GIF links inline"
```

---

## Verification

- `npm test` passes (Task 1 and Task 2 tests).
- `node --check server.js`, `node --check public/js/embed.js`, `node --check public/js/text-format.js` all pass.
- Manual browser test: Tenor and Giphy share links render inline; direct media links render without a server round-trip; unsupported URLs fall back to the plain link.
- No `Content-Security-Policy` change; no iframe used for GIFs.
