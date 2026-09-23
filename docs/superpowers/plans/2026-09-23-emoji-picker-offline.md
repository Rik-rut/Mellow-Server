# Emoji Picker Offline Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the emoji picker load its emoji data from the Mellow server itself so it works offline on a LAN with no CSP violation.

**Architecture:** Vendor the `emoji-picker-element-data` English dataset into `public/js/lib/emoji-picker-element-data/en/emojibase/data.json`, then point both `<emoji-picker>` elements at that same-origin path via the library's `data-source` attribute. No CSP change and no library code change.

**Tech Stack:** Static assets served by Express (`express.static('public')`), `emoji-picker-element@1.29.1` (vendored), plain HTML attributes.

## Global Constraints

- Do not modify any file under `public/js/lib/emoji-picker-element/` (third-party vendored library).
- Do not change the `Content-Security-Policy` header in `server.js`. `connect-src 'self' ws: wss:` must stay exactly as-is.
- The data file must be the exact `emojibase` format produced by npm package `emoji-picker-element-data@^1` (a JSON array whose first record has keys `annotation`, `emoji`, `group`, `order`, `version`).
- English locale only.
- Windows PowerShell 5.1 environment; use `Invoke-WebRequest` or `curl.exe` for downloads.

---

### Task 1: Vendor the English emoji dataset into `public/`

**Files:**
- Create: `public/js/lib/emoji-picker-element-data/en/emojibase/data.json`

**Interfaces:**
- Consumes: nothing.
- Produces: a static file at URL path `/js/lib/emoji-picker-element-data/en/emojibase/data.json`, served by the existing `express.static(path.join(__dirname, 'public'))` mount in `server.js:441`.

- [ ] **Step 1: Create the target directory**

```powershell
New-Item -ItemType Directory -Force -Path "public/js/lib/emoji-picker-element-data/en/emojibase" | Out-Null
```

- [ ] **Step 2: Download the dataset from the npm package via jsdelivr**

```powershell
curl.exe -L "https://cdn.jsdelivr.net/npm/emoji-picker-element-data@1/en/emojibase/data.json" -o "public/js/lib/emoji-picker-element-data/en/emojibase/data.json"
```

Expected: file exists at `public/js/lib/emoji-picker-element-data/en/emojibase/data.json` and is roughly 430 KB.

- [ ] **Step 3: Verify the download is valid JSON in the expected format**

```powershell
node -e "const d=require('./public/js/lib/emoji-picker-element-data/en/emojibase/data.json'); const req=['annotation','emoji','group','order','version']; const ok=Array.isArray(d)&&d.length>0&&req.every(k=>k in d[0]); console.log('records:', d.length, 'format-ok:', ok); process.exit(ok?0:1)"
```

Expected output: `records: <positive number> format-ok: true` and exit code 0.

- [ ] **Step 4: Commit**

```bash
git add public/js/lib/emoji-picker-element-data/en/emojibase/data.json
git commit -m "chore: vendor offline emoji data for emoji-picker-element"
```

---

### Task 2: Point both pickers at the local data source

**Files:**
- Modify: `public/index.html:331` (composer picker)
- Modify: `public/index.html:730` (reaction picker)

**Interfaces:**
- Consumes: `/js/lib/emoji-picker-element-data/en/emojibase/data.json` from Task 1.
- Produces: nothing consumed elsewhere; this is the end of the feature.

- [ ] **Step 1: Add `data-source` to the composer picker**

Replace:

```html
            <emoji-picker></emoji-picker>
```

with:

```html
            <emoji-picker data-source="/js/lib/emoji-picker-element-data/en/emojibase/data.json"></emoji-picker>
```

- [ ] **Step 2: Add `data-source` to the reaction picker**

Replace:

```html
          <emoji-picker id="reaction-emoji-picker"></emoji-picker>
```

with:

```html
          <emoji-picker id="reaction-emoji-picker" data-source="/js/lib/emoji-picker-element-data/en/emojibase/data.json"></emoji-picker>
```

- [ ] **Step 3: Verify the attribute is present on both elements**

```powershell
Select-String -Path public/index.html -Pattern "emoji-picker-element-data/en/emojibase/data.json" | Measure-Object | Select-Object -ExpandProperty Count
```

Expected: `2`.

- [ ] **Step 4: Manual verification (browser)**

Start the server (`npm start`), open the app, open DevTools → Console, and click the composer emoji button. Expected:
- Emoji categories and emojis load.
- No `Content Security Policy` error mentioning `cdn.jsdelivr.net`.
- Network tab shows a request to `/js/lib/emoji-picker-element-data/en/emojibase/data.json` returning `200`.
- Disconnect from the internet and reload: picker still loads (IndexedDB cache or local fetch).

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "fix: load emoji picker data from same-origin to satisfy CSP"
```

---

## Verification

- Both `<emoji-picker>` elements carry `data-source` (`public/index.html`).
- Data file present at `public/js/lib/emoji-picker-element-data/en/emojibase/data.json` and valid.
- No changes to `server.js` CSP.
- Manual browser check passes with the network unplugged.
