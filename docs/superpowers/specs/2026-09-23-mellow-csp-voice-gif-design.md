# Design: Emoji Picker CSP Fix, Voice One-Way Audio Fix, Tenor/Giphy GIF Support

Date: 2026-09-23
Status: Approved (pending final spec review)
Repo: Mellow-Server (Node/Express + `ws` + vanilla JS)

## Context

Mellow is a LAN-first, no-internet chat and voice server. Three reported issues:

1. The emoji picker logs a Content Security Policy (CSP) error and fails to load:
   `Connecting to 'https://cdn.jsdelivr.net/npm/emoji-picker-element-data@^1/en/emojibase/data.json' violates ... "connect-src 'self' ws: wss:"`.
2. Voice chat (VC) audio is sometimes one-directional: one participant hears the
   other but not vice versa.
3. No inline preview for Tenor/Giphy GIF links; the desire is for a pasted GIF link
   to render as an inline animated image.

This document covers the design for all three. They are independent workstreams;
each can ship separately.

---

## Part 1 — Emoji picker data (self-host, offline)

### Root cause

The picker is vendored at `public/js/lib/emoji-picker-element/` and loaded as an ES
module (`public/index.html:966`). Its `dataSource` defaults to the jsdelivr CDN
(`database.js:33`, `picker.js:1649`). No emoji data ships with the repo, so the
picker fetches JSON from jsdelivr at runtime. The server's CSP
`connect-src 'self' ws: wss:` (`server.js:425`) blocks that fetch. This also breaks
the offline/LAN promise of the product.

### Approach

Vendor the English emoji data file into the app and point both picker instances at
it. No CSP change.

- Add the data file at
  `public/js/lib/emoji-picker-element-data/en/emojibase/data.json`
  (sourced from npm package `emoji-picker-element-data@^1`,
  path `en/emojibase/data.json`; ~430 KB). This is the exact format the library
  expects (array of emoji records with `annotation`, `emoji`, `group`, `order`,
  `version`).
- Set `data-source="/js/lib/emoji-picker-element-data/en/emojibase/data.json"` on
  both `<emoji-picker>` elements in `public/index.html` (composer picker at line
  331; reaction picker at line 730).
- Data is served same-origin by the existing `express.static('public')` mount
  (`server.js:441`), which emits an `ETag`. The library's update check
  (`HEAD` then compare) therefore works locally.

### Why not alternatives

- Relaxing `connect-src` to include jsdelivr weakens CSP and keeps a hard CDN
  dependency, contradicting the offline design.
- A CDN fallback adds complexity for no benefit once data is local.

### Scope / non-goals

- English only (matches current default `locale: 'en'`). Other locales can be added
  later by dropping more files and setting `data-source` per locale.
- No picker library code is modified; only configuration and a data asset.

### Acceptance criteria

1. Opening the emoji picker shows categories and emoji with no CSP error in the
   console, with the server unreachable from the public internet (LAN only).
2. Both composer and reaction pickers load data.
3. No `connect-src` change in `server.js`.

---

## Part 2 — Voice one-way audio

### Architecture recap

Full mesh WebRTC in `public/js/main.js`; `server.js` only relays SDP/ICE
(`voice:offer`, `voice:answer`, `voice:ice-candidate`). Each pair of participants
has one `RTCPeerConnection`. Lower user id is the "polite"/initiating peer
(`main.js:7562`, `main.js:1549`). ICE servers are STUN-only; no TURN
(`main.js:7554-7557`).

### Root causes identified

1. **Queued ICE candidates are discarded.** `createPeerConnection` calls
   `closePeerConnection(userId)` (`main.js:7551`), which runs
   `delete voiceIceCandidateQueues[userId]` (`main.js:7730`). Meanwhile
   `handleVoiceIceCandidate` intentionally queues candidates that arrive before the
   remote description (`main.js:7694`). With `iceCandidatePoolSize: 1`
   (`main.js:7558`), candidates can be sent before the offer, so a receiver can
   queue them and then lose them when the offer creates the PC. On a LAN with
   host-only candidates this frequently yields no viable pair → one-way or no audio
   until ICE recovery.
2. **Renegotiation offers are silently dropped.** `renegotiatePeerConnection`
   returns when `pc.signalingState !== 'stable'` (`main.js:7187`) and there is no
   `onnegotiationneeded` handler. Late camera/screen/late-join track additions
   (`main.js:6829`, `7007`, `7015`, `1563-1589`) rely on this function; a drop
   means a track exists locally but is never negotiated → one-way video.
3. **Recovery does not restart ICE properly.** `scheduleIceRecovery`
   (`main.js:7536`) makes a normal re-offer via `renegotiatePeerConnection`; it
   never calls `pc.restartIce()`, and after exhausting attempts it gives up.
4. **Autoplay can be blocked on reconnect.** On a WS drop the client auto-rejoins
   voice without a user gesture (`main.js:1017-1026`, `rejoinVoiceChannel`
   `main.js:6515`). Remote `<audio>.play()` (`main.js:7449`) may then be rejected,
   producing "they hear me, I don't hear them" until a click.

### Approach (fix all root causes; client-only)

All changes are in `public/js/main.js`. No server changes.

1. **Preserve the ICE queue when (re)building a PC.**
   - Change `closePeerConnection(userId)` to `closePeerConnection(userId, opts)` and
     only `delete voiceIceCandidateQueues[userId]` when not preserving.
   - In `createPeerConnection`, call `closePeerConnection(userId, { keepIceQueue: true })`
     (`main.js:7551`). Queued candidates then survive and are flushed by
     `handleVoiceOffer` (`main.js:7656`) or `handleVoiceAnswer` (`main.js:7681`).
   - Explicit teardown paths (leaving a channel, peer left) keep deleting the queue.

2. **Reliable renegotiation without glare.**
   - In `renegotiatePeerConnection`, when `signalingState !== 'stable'`, set
     `pc._pendingRenegotiate = true` and return instead of dropping.
   - After a successful remote-answer application (`handleVoiceAnswer`, in the
     `.then` after `setRemoteDescription`) and after `handleVoiceOffer` finishes
     sending its answer, if `pc._pendingRenegotiate` is set, clear it and call
     `renegotiatePeerConnection(userId)` again.
   - Deliberately no `onnegotiationneeded`: keeping offers explicit avoids double
     offers and preserves the existing polite/impolite glare handling.

3. **Proper ICE restart and last-resort rebuild.**
   - In `scheduleIceRecovery`, call `pc.restartIce()` (when available) before
     `renegotiatePeerConnection`, so the new offer carries fresh ICE credentials.
   - After `MAX_ICE_RESTARTS` is exceeded, rebuild: `closePeerConnection(userId)`
     then `createPeerConnection(userId, name, initiator)` where
     `initiator = currentUser.id < userId` (matching the `main.js:1549` rule) to
     re-establish from scratch.

4. **Autoplay hardening.**
   - Add a one-time document-level `pointerdown`/`keydown` listener that retries
     `play()` on every element in `voiceAudioElements` and clears itself after the
     first success.
   - Keep the existing per-element click retry (`main.js:7440`) and the "Click to
     hear" indicator; ensure it is shown again on the auto-rejoin path.

### Acceptance criteria

1. Two peers joining a voice channel reliably hear each other; repeated
   join/leave/rejoin does not leave a silent direction.
2. Toggling camera/screen on after joining negotiates on both sides (remote sees
   the media) without requiring a rejoin.
3. A simulated mid-call WS drop + auto-rejoin restores audio; if autoplay was
   blocked, the first click/keypress restores it.
4. Manually verified with at least two real browsers on the LAN.

---

## Part 3 — Tenor/Giphy GIF links render inline

### Current state

URL detection is `TextFormat.detectProvider` (`text-format.js:31-77`), which
recognizes YouTube/TikTok/Instagram/Facebook. Provider URLs become
`<span class="embed-slot" data-provider data-id data-media-type data-url>`
(`main.js:3844`) and `Embed.createUnifiedCard` (`embed.js:81`) renders per-provider
content. `img-src 'self' data: blob: https:` already allows external HTTPS images;
`connect-src 'self' ws: wss:` blocks direct client calls to third-party APIs, so
resolution must happen server-side (same-origin).

### Approach: server-side oEmbed + inline image

**1. Detection (`text-format.js`)**
Add `tenor` and `giphy` branches to `detectProvider`, returning
`{ provider, videoId: <id-or-slug>, mediaType: 'gif' }`:
- Tenor pages: `tenor.com/view/<slug>-<id>`, `tenor.com/<id>.gif`,
  `tenor.com/<locale>/view/...`.
- Giphy pages: `giphy.com/gifs/<slug>-<id>`, `giphy.com/media/<id>`,
  `giphy.com/<slug>/gifs/...`.
- Direct media: `media.tenor.com/...`, `media.giphy.com/...`, `i.giphy.com/...`,
  `media0-4.giphy.com/...`.
No changes to the token → `.embed-slot` pipeline are needed.

**2. Server endpoint (`server.js`)**
New `GET /api/embed/gif?url=`:
- Validate `url` is `https:` and its host is in a Tenor/Giphy allowlist (page or
  media hosts). This allowlist is separate from `isEmbedAllowedHost`,
  which stays Instagram-only.
- If the URL is already a direct media CDN URL, return it directly.
- Otherwise fetch the provider oEmbed JSON:
  - Giphy: `https://giphy.com/services/oembed?url=<encoded>`
  - Tenor: `https://tenor.com/oembed?url=<encoded>`
  - No API key required.
- Extract the media URL from the oEmbed `url` field. Re-validate the extracted host
  against the CDN allowlist (SSRF guard, including after any redirect).
- Respond `{ image, title, width, height }`.
- Reuse a bounded cache `Map` (FIFO eviction, like `previewCache`) and the existing
  `tooManyAttempts` rate limiter.
- Cache both positive results and short-lived negatives to avoid hammering.

**3. Client render (`embed.js`)**
- Add `tenor` / `giphy` cases to `getProviderMeta` (name, icon class, type label
  "GIF", theme class).
- Add a branch in `createUnifiedCard` for `provider === 'tenor' || 'giphy'`:
  - If `id`/url is already a direct media URL, render the `<img>` immediately.
  - Else `fetch('/api/embed/gif?url=...')`, then render an inline `<img>` with the
    returned `image`, `loading="lazy"`, and provider-themed styling.
  - On failure, fall back to the plain link (already present in the slot).
- Do not render an iframe (keeps `frame-src` unchanged).

**4. CSP**
No change. `img-src https:` covers `media.tenor.com` / `media.giphy.com`; the
same-origin `fetch` satisfies `connect-src`; no iframe is used.

**5. CSS + cache-busting**
- Add `.embed-gif` plus `.embed-tenor` / `.embed-giphy` theme classes in
  `public/css/style.css`, sized consistently with existing embed media
  (max-width/height, rounded corners).
- Because GIFs render inside `.message-text`-adjacent embed markup, clicking the
  image is not required to open the lightbox; the existing lightbox selector
  (`main.js:3481`) targets `.message-text img`, so embed GIFs are intentionally not
  part of it. (GIFs remain inline and animated.)
- Bump `text-format.js?v=` and `embed.js?v=` query strings in `public/index.html`.

### Security notes

- Only validated Tenor/Giphy hosts are fetched or rendered; the extracted media
  host is re-validated after redirect.
- oEmbed responses are parsed as JSON; `image` must be an allowed `https:` host
  before it reaches the client.
- Rate limiting and cache bounds mirror existing embed endpoints.

### Acceptance criteria

1. Pasting a Tenor share link and a Giphy share link each renders an inline
   animated GIF in the message, with the original link still present.
2. Pasting a direct `media.tenor.com` / `media.giphy.com` GIF URL renders it without
   a server round-trip.
3. Invalid or non-allowlisted URLs show the plain link, no console errors, no CSP
   violations.
4. No iframe is used for GIFs; `frame-src` and `connect-src` are unchanged.

---

## Risks and mitigations

- **Voice changes touch core signaling.** Mitigation: changes are small and
  localized; test with two real browsers and the existing glare/rollback logic
  preserved. No server changes.
- **oEmbed availability/rate limits.** Mitigation: bounded cache, negative caching,
  and graceful fallback to the plain link.
- **Emoji data size (~430 KB).** Acceptable one-time same-origin fetch, cached in
  IndexedDB by the library.

## Out of scope

- TURN server support (noted as a possible future enhancement).
- Adding more emoji locales.
- Tenor/Giphy search, trending, or a GIF picker UI.
