# Voice One-Way Audio Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate one-directional (or absent) WebRTC voice audio in Mellow's mesh calls by preserving queued ICE candidates, making renegotiation reliable, restarting ICE properly, and hardening remote-audio autoplay.

**Architecture:** Client-only changes in `public/js/main.js`. The mesh architecture (one `RTCPeerConnection` per remote user, SDP/ICE relayed by `server.js`) is unchanged. Each fix is small and localized to the connection lifecycle functions.

**Tech Stack:** Vanilla JS, WebRTC (`RTCPeerConnection`), native `<audio>` playback. No build step.

## Global Constraints

- All changes are in `public/js/main.js` only. Do not modify `server.js` signaling.
- Preserve the existing polite/impolite glare logic (`pc.polite`, `pc.makingOffer`, `pc.ignoreOffer`, rollback in `handleVoiceOffer`).
- Do not add an `onnegotiationneeded` handler; offers remain explicit to avoid double-offer glare.
- Keep the existing user-facing "Click to hear" indicator text.
- Windows PowerShell 5.1 environment. There is no automated JS test harness in this repo; verification is by syntax check plus manual multi-browser testing.

---

### Task 1: Preserve the ICE candidate queue when (re)building a peer connection

**Files:**
- Modify: `public/js/main.js:7702-7735` (`closePeerConnection`)
- Modify: `public/js/main.js:7548-7551` (`createPeerConnection`)

**Interfaces:**
- Consumes: `voiceIceCandidateQueues` (declared `public/js/main.js:501`), `flushIceCandidateQueue(userId, pc)` (`public/js/main.js:7525`).
- Produces: `closePeerConnection(userId, opts)` where `opts.keepIceQueue === true` skips `delete voiceIceCandidateQueues[userId]`. All existing callers that pass no second argument keep current behavior.

- [ ] **Step 1: Add the `opts.keepIceQueue` parameter to `closePeerConnection`**

Replace the signature and the queue deletion line. The current code is:

```js
function closePeerConnection(userId) {
  const pc = voicePeerConnections[userId];
```

and later:

```js
  delete voiceIceCandidateQueues[userId];
  delete pendingVideoKinds[userId];
```

Change to:

```js
function closePeerConnection(userId, opts) {
  const keepIceQueue = !!(opts && opts.keepIceQueue);
  const pc = voicePeerConnections[userId];
```

and:

```js
  if (!keepIceQueue) delete voiceIceCandidateQueues[userId];
  delete pendingVideoKinds[userId];
```

- [ ] **Step 2: Pass `keepIceQueue` when `createPeerConnection` rebuilds**

In `createPeerConnection`, the current code is:

```js
  if (voicePeerConnections[userId]) return voicePeerConnections[userId];
  closePeerConnection(userId);
```

Change the `closePeerConnection` call to:

```js
  if (voicePeerConnections[userId]) return voicePeerConnections[userId];
  closePeerConnection(userId, { keepIceQueue: true });
```

- [ ] **Step 3: Syntax-check the file**

```powershell
node --check public/js/main.js
```

Expected: no output, exit code 0.

- [ ] **Step 4: Confirm the only behavior change is the preserved queue**

```powershell
Select-String -Path public/js/main.js -Pattern "closePeerConnection\("
```

Expected: the call inside `createPeerConnection` now reads `closePeerConnection(userId, { keepIceQueue: true });`; the teardown calls at `leaveVoiceChannel` (~line 6629) and `voice:user:left` (~line 1525) remain single-argument, so explicit teardown still clears the queue.

- [ ] **Step 5: Manual verification (two browsers on the LAN)**

Join the same voice channel from two browsers. Expected: audio flows both ways on first join and after several leave/rejoin cycles. In DevTools console (with `vlog` enabled if available) there should be no lost-candidate symptoms; `pc.iceConnectionState` reaches `connected` on both sides.

- [ ] **Step 6: Commit**

```bash
git add public/js/main.js
git commit -m "fix(voice): preserve queued ICE candidates when creating peer connection"
```

---

### Task 2: Make renegotiation reliable without offer glare

**Files:**
- Modify: `public/js/main.js:7184-7208` (`renegotiatePeerConnection`)
- Modify: `public/js/main.js:7675-7689` (`handleVoiceAnswer`)
- Modify: `public/js/main.js:7645-7672` (`handleVoiceOffer`)

**Interfaces:**
- Consumes: `renegotiatePeerConnection(userId)`, `voicePeerConnections[userId]`.
- Produces: `pc._pendingRenegotiate` boolean flag. `renegotiatePeerConnection` never silently drops an offer request: when not `stable` it sets `_pendingRenegotiate` and returns; the flag is drained by `handleVoiceAnswer` and at the end of `handleVoiceOffer`.

- [ ] **Step 1: Queue the renegotiation instead of dropping it**

In `renegotiatePeerConnection`, current code:

```js
function renegotiatePeerConnection(userId) {
  const pc = voicePeerConnections[userId];
  if (!pc || !voiceChannelId) return;
  if (pc.signalingState !== 'stable') return;
  pc.makingOffer = true;
```

Change to:

```js
function renegotiatePeerConnection(userId) {
  const pc = voicePeerConnections[userId];
  if (!pc || !voiceChannelId) return;
  if (pc.signalingState !== 'stable') {
    pc._pendingRenegotiate = true;
    return;
  }
  pc.makingOffer = true;
```

- [ ] **Step 2: Drain the pending flag after applying a remote answer**

In `handleVoiceAnswer`, current code:

```js
  pc.setRemoteDescription(new RTCSessionDescription(sdp)).then(() => {
    pc.isSettingRemoteAnswerPending = false;
    flushIceCandidateQueue(userId, pc);
    if (pc.screenVideoSender) {
      applyHighFpsEncodingParameters(pc.screenVideoSender);
    }
  }).catch(e => {
```

Change the `.then` body to:

```js
  pc.setRemoteDescription(new RTCSessionDescription(sdp)).then(() => {
    pc.isSettingRemoteAnswerPending = false;
    flushIceCandidateQueue(userId, pc);
    if (pc.screenVideoSender) {
      applyHighFpsEncodingParameters(pc.screenVideoSender);
    }
    if (pc._pendingRenegotiate) {
      pc._pendingRenegotiate = false;
      renegotiatePeerConnection(userId);
    }
  }).catch(e => {
```

- [ ] **Step 3: Drain the pending flag at the end of handling an offer**

In `handleVoiceOffer`, after the answer is sent, the current code ends with:

```js
    if (voiceChannelId) {
      sendWS('voice:answer', {
        channelId: voiceChannelId,
        targetUserId: userId,
        sdp: pc.localDescription
      });
    }
  } catch (e) {
    console.error('Answer error:', e);
  }
```

Change to add the drain inside the `try`, after the `sendWS` block:

```js
    if (voiceChannelId) {
      sendWS('voice:answer', {
        channelId: voiceChannelId,
        targetUserId: userId,
        sdp: pc.localDescription
      });
    }
    if (pc._pendingRenegotiate) {
      pc._pendingRenegotiate = false;
      renegotiatePeerConnection(userId);
    }
  } catch (e) {
    console.error('Answer error:', e);
  }
```

- [ ] **Step 4: Syntax-check the file**

```powershell
node --check public/js/main.js
```

Expected: no output, exit code 0.

- [ ] **Step 5: Manual verification (two browsers)**

Join the channel from both. On browser A, enable the camera, then screen share, then stop both; on browser B do the same. Expected: in every case the other side receives the media (video appears / stops) without requiring a rejoin. No console errors containing `Renegotiation error`.

- [ ] **Step 6: Commit**

```bash
git add public/js/main.js
git commit -m "fix(voice): retry renegotiation instead of dropping offers mid-signaling"
```

---

### Task 3: Proper ICE restart and last-resort rebuild

**Files:**
- Modify: `public/js/main.js:7534-7546` (`MAX_ICE_RESTARTS`, `scheduleIceRecovery`)

**Interfaces:**
- Consumes: `closePeerConnection(userId)`, `createPeerConnection(userId, username, initiator)`.
- Produces: on recovery, `pc.restartIce()` is called when available; after `MAX_ICE_RESTARTS` the connection is fully rebuilt with `initiator = currentUser.id < userId`.

- [ ] **Step 1: Add `restartIce` and rebuild-after-max to `scheduleIceRecovery`**

Current code:

```js
const MAX_ICE_RESTARTS = 2;

function scheduleIceRecovery(userId) {
  const key = String(userId);
  const attempts = voiceRestartAttempts[key] || 0;
  if (attempts >= MAX_ICE_RESTARTS) {
    vlog('giving up on', userId, 'after', attempts, 'restarts');
    return;
  }
  voiceRestartAttempts[key] = attempts + 1;
  vlog('ice restart attempt', attempts + 1, 'for', userId);
  renegotiatePeerConnection(userId);
}
```

Change to:

```js
const MAX_ICE_RESTARTS = 2;

function scheduleIceRecovery(userId) {
  const key = String(userId);
  const attempts = voiceRestartAttempts[key] || 0;
  const pc = voicePeerConnections[userId];
  if (!pc) return;

  if (attempts >= MAX_ICE_RESTARTS) {
    vlog('rebuilding peer connection for', userId, 'after', attempts, 'restarts');
    const info = voiceParticipantsByChannel[voiceChannelId]
      ? voiceParticipantsByChannel[voiceChannelId].find(p => p.userId === userId)
      : null;
    const name = (info && info.username) || pc._username || 'peer';
    closePeerConnection(userId);
    voiceRestartAttempts[key] = 0;
    createPeerConnection(userId, name, currentUser.id < userId);
    return;
  }

  voiceRestartAttempts[key] = attempts + 1;
  vlog('ice restart attempt', attempts + 1, 'for', userId);
  if (typeof pc.restartIce === 'function') {
    try { pc.restartIce(); } catch (_) {}
  }
  renegotiatePeerConnection(userId);
}
```

- [ ] **Step 2: Record the peer username on the PC so rebuilds keep a label**

In `createPeerConnection`, right after `voicePeerConnections[userId] = pc;`, the current code is:

```js
  voicePeerConnections[userId] = pc;
  pc.polite = currentUser.id.localeCompare(String(userId)) < 0;
```

Change to:

```js
  voicePeerConnections[userId] = pc;
  pc._username = username;
  pc.polite = currentUser.id.localeCompare(String(userId)) < 0;
```

- [ ] **Step 3: Syntax-check the file**

```powershell
node --check public/js/main.js
```

Expected: no output, exit code 0.

- [ ] **Step 4: Confirm rebuild initiator matches the join rule**

```powershell
Select-String -Path public/js/main.js -Pattern "currentUser.id < userId"
```

Expected: matches appear both in the `voice:participants` handler (~line 1549) and in the new `scheduleIceRecovery` rebuild line, so the re-initiated offer follows the same ordering rule.

- [ ] **Step 5: Manual verification (two browsers)**

Join from both, confirm audio, then have one peer toggle their network adapter off and on (or block UDP) for ~15 seconds. Expected: media recovers after ICE restart or, if not, after the full rebuild; audio resumes without a manual rejoin.

- [ ] **Step 6: Commit**

```bash
git add public/js/main.js
git commit -m "fix(voice): restart ICE on recovery and rebuild connection when retries are exhausted"
```

---

### Task 4: Harden remote-audio autoplay after gesture-less reconnects

**Files:**
- Modify: `public/js/main.js:7421-7466` (`attachRemoteAudio`)
- Modify: `public/js/main.js` (add a document-level resume listener near the miniplayer/visibility block, ~line 7762)

**Interfaces:**
- Consumes: `voiceAudioElements` (userId → `<audio>`), declared `public/js/main.js:500`.
- Produces: `resumeVoiceAudio()` helper that attempts `play()` on every `voiceAudioElements` entry and returns a `Promise`. A one-time document `pointerdown`/`keydown` listener calls it and removes itself once all elements are playing.

- [ ] **Step 1: Add the `resumeVoiceAudio` helper and one-time listener**

In `public/js/main.js`, immediately after `attachRemoteAudio` ends (after the `canplaythrough` listener, before `function attachRemoteScreenAudio`), insert:

```js
let voiceAudioResumeBound = false;

function resumeVoiceAudio() {
  const attempts = Object.keys(voiceAudioElements).map(userId => {
    const audio = voiceAudioElements[userId];
    if (!audio || audio.paused === false) return Promise.resolve();
    return audio.play().catch(() => {});
  });
  return Promise.all(attempts);
}

function bindVoiceAudioResume() {
  if (voiceAudioResumeBound) return;
  voiceAudioResumeBound = true;
  const handler = () => {
    resumeVoiceAudio().then(() => {
      const anyPaused = Object.values(voiceAudioElements).some(a => a && a.paused);
      if (!anyPaused) {
        document.removeEventListener('pointerdown', handler, true);
        document.removeEventListener('keydown', handler, true);
      }
    });
  };
  document.addEventListener('pointerdown', handler, true);
  document.addEventListener('keydown', handler, true);
}
```

- [ ] **Step 2: Bind the resume listener when autoplay is blocked**

In `attachRemoteAudio`, the current autoplay-failure branch is:

```js
  audio.play().catch(err => {
    console.log('Remote audio autoplay blocked, click participant to enable:', userId);
    // Show visual indicator on the participant
    const el = document.getElementById(`vp-${userId}`);
    if (el) {
      const status = el.querySelector('.voice-participant-status');
      if (status) {
        status.textContent = '🔇 Click to hear';
        status.style.color = 'var(--text-muted)';
      }
    }
  });
```

Change it to also bind the global resume listener:

```js
  audio.play().catch(err => {
    console.log('Remote audio autoplay blocked, click participant to enable:', userId);
    bindVoiceAudioResume();
    // Show visual indicator on the participant
    const el = document.getElementById(`vp-${userId}`);
    if (el) {
      const status = el.querySelector('.voice-participant-status');
      if (status) {
        status.textContent = '🔇 Click to hear';
        status.style.color = 'var(--text-muted)';
      }
    }
  });
```

- [ ] **Step 3: Syntax-check the file**

```powershell
node --check public/js/main.js
```

Expected: no output, exit code 0.

- [ ] **Step 4: Manual verification (two browsers)**

With two peers in a call, force a WebSocket drop so the client auto-rejoins without a gesture (e.g. restart the server process briefly with the tab in the background). Expected: on returning to the tab, if audio was blocked, the first click or keypress resumes all remote audio; the "Click to hear" indicator was shown.

- [ ] **Step 5: Commit**

```bash
git add public/js/main.js
git commit -m "fix(voice): resume remote audio on first user gesture after blocked autoplay"
```

---

## Verification

- `node --check public/js/main.js` passes.
- Two-browser manual tests pass for Tasks 1–4.
- No changes to `server.js`; no new signaling message types.
- Glare handling (`pc.polite`, rollback) is unchanged.
