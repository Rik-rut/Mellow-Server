# Mellow Server — Decentralized LAN Chat Application

Run your own private chat server on your home network (LAN) — **no internet required, no subscriptions, no cloud dependencies, and no data leaving your local network**.

**Mellow** is a self-hosted, Discord-style collaboration platform for family, friends, LAN parties, or office teams. It provides real-time text channels, direct messages, peer-to-peer voice and video calls, system audio screen sharing, file sharing, and rich media embeds — all hosted from a single computer and accessible via any web browser on your network.

> **Tech Stack:** Node.js (v22.5+), Express, WebSockets (`ws`), WebRTC mesh, SQLite (`node:sqlite`), and vanilla web standards.

---

## Features

- **Multi-Server & Categories** — Organize channels by server and categories (Text Channels, Voice Channels) with custom permissions.
- **Text Channels & Direct Messages (DMs)** — Real-time messaging, unread notifications, message editing, replies, pins, and emoji reactions.
- **Voice & Video Calls** — Low-latency peer-to-peer WebRTC mesh calls, camera grid, and in-call text chat.
- **Screen Sharing with Audio** — High-definition screen sharing with optional tab/system audio capture and Picture-in-Picture (PiP) support.
- **AI Noise Suppression** — Built-in client-side DSP options:
  - **RNNoise** (fast, lightweight WebAssembly model)
  - **DeepFilterNet3** (full-band 48 kHz deep-learning model with live strength tuning)
  - Browser built-in audio processing
- **File & Media Sharing** — Upload and share files up to 50 MB with inline previews for images, video, and audio.
- **Rich Media Embeds** — Inline players for YouTube, YouTube Shorts, and TikTok with secure sandboxing.
- **Security & Privacy**:
  - Auto-generated self-signed HTTPS certificates (enables microphone, camera, and screen sharing APIs).
  - PBKDF2-SHA512 password hashing with modern salt stretching.
  - Secure session management with UUID tokens and sliding expiration.
  - Rate limiting, CSP hardening, and upload file type allowlisting.
  - Admin dashboard with two-step registration approvals (prevent unauthorized joins).
- **Zero Configuration Discovery** — Answers local UDP broadcast discovery queries on port 6768 for instant client auto-detection.

---

## Prerequisites

- **Node.js**: **v22.5.0 or higher** (required for native `node:sqlite` support).
  - Verify with: `node --version`
  - Download from: <https://nodejs.org> (Node 22 LTS or newer)

---

## Quick Start

### 1. Launch the Server

Open a terminal inside the `Mellow-Server` directory and run:

```bash
npm start
```

*(Alternatively: `node server.js`)*

On startup, the console will display:

```
LAN discovery answering UDP broadcasts on :6768
mellow-server running on https://0.0.0.0:6767
```

Leave this terminal window running while the server is in use. To stop the server, press `Ctrl + C`.

### 2. Find Your LAN IP Address

To allow other devices to connect, find the host computer's local IPv4 address:

- **Windows**: Run `ipconfig` in Command Prompt or PowerShell (look for `IPv4 Address`, e.g., `192.168.1.5`).
- **macOS / Linux**: Run `ip addr` or `ifconfig`.

### 3. Access in Browser

On any phone, tablet, or PC connected to the same Wi-Fi or office network, open:

```
https://<YOUR-IP>:6767
```

*(Example: `https://192.168.1.5:6767`)*

#### Self-Signed Certificate Note:
Because Mellow creates its own local SSL certificate (required by modern browsers for microphone and camera access), your browser will display a security warning on first visit:
- **Chrome / Edge**: Click **Advanced** → **Proceed to `<ip>` (unsafe)**.
- **Firefox**: Click **Advanced** → **Accept the Risk and Continue**.
- **Safari / iOS**: Tap **Show Details** → **Visit this website**.

### 4. Create the Admin / Owner Account

1. Click **Register** and enter a username and password (minimum 8 characters).
2. For the **first registered account**, look at the server console window: it will print an authorization line with a 6-digit confirmation code:
   ```
   [Mellow] "username" wants to register. Confirmation code: 123456
   ```
3. Enter that 6-digit code on the registration screen and click **Confirm code**.
4. This first account automatically becomes the **Server Owner / Admin**.
5. Subsequent users who register will appear under **Admin Dashboard → Registration requests**, where admins can approve or deny requests in real time.

---

## Server Architecture & Files

This repository contains the standalone server and web client:

```
Mellow-Server/
├── server.js          # Core HTTP/HTTPS, WebSocket signaling, and REST API server
├── server/
│   ├── db.js          # Synchronous SQLite database engine (node:sqlite, WAL mode)
│   ├── discovery.js   # UDP broadcast discovery listener (port 6768)
│   └── read-state.js  # Read receipt and unread message tracking
├── public/            # Static frontend client (HTML, CSS, JS, sound effects, icons)
├── package.json       # Node package configuration and npm start script
├── package-lock.json  # Locked dependency tree
├── .gitignore         # Ignores runtime data and node_modules
└── README.md          # Server documentation
```

### Runtime Data Directory (`data/`)

On its first run, the server automatically creates a `data/` directory containing:
- `data/mellow.db` — SQLite database containing users, servers, channels, messages, pins, and tokens (uses WAL journal mode for crash resistance).
- `data/certs/` — Auto-generated self-signed SSL certificate (`cert.pem` and `key.pem`).
- `data/uploads/` — Stored user file uploads and profile pictures.

---

## Everyday Usage

- **Channels**: Switch between text and voice channels in the left sidebar. Server owners can create categories and channels.
- **Voice & Video**: Click any voice channel to connect. Toggle microphone, camera, or screen sharing using the voice controls bar.
- **Noise Suppression**: Open **Settings → Voice & Audio** to adjust microphone processing (RNNoise or DeepFilterNet3) and test audio input levels.
- **Direct Messages**: Click the Home icon to view friends, direct conversations, and pending requests.
- **Sharing Files**: Drag and drop files directly onto the chat window or click the attachment icon (up to 50 MB per file).

---

## Connecting Over the Internet (Optional)

To connect with friends or coworkers outside your local network without port forwarding or exposing ports to the public internet, use a private mesh VPN:

1. Install **Tailscale** (<https://tailscale.com>), **NetBird** (<https://netbird.io>), or **Radmin VPN** on the server machine and client devices.
2. Connect all devices to the same private mesh network.
3. Open `https://<VPN-IP>:6767` in the browser using the server machine's assigned VPN IP.

---

## Configuration & Administration

### Resetting Admin or Database

To wipe all data and start completely fresh:
1. Stop the server (`Ctrl + C`).
2. Delete the `data/mellow.db` file (or delete the entire `data/` folder).
3. Start the server (`npm start`).
4. Register the new account and approve it with the 6-digit code shown in the console.

### Ports & Firewall

- **TCP 6767**: Web application and WebSocket connections (HTTPS/WSS).
- **UDP 6768**: LAN discovery responder (enables Mellow desktop clients to find the server automatically).

If other computers cannot access the server, allow inbound TCP on port `6767` and UDP on port `6768` in your operating system's firewall (e.g., Windows Defender Firewall).

---

## Troubleshooting

| Issue | Solution |
|---|---|
| **`node:sqlite` or syntax error on startup** | Ensure you are running Node.js **v22.5.0 or higher** (`node --version`). |
| **"Cannot find module" error** | Run `npm install` inside the `Mellow-Server` directory to restore dependencies. |
| **Other devices cannot connect** | Verify both devices are on the same Wi-Fi/LAN network. Ensure Windows Firewall allows incoming connections on port `6767`. |
| **Microphone or camera not working** | Ensure you are connecting via `https://` (not `http://`). Browsers require secure origins for media capture APIs. Accept the self-signed certificate warning. |
| **Forgotten admin credentials** | Stop the server, delete `data/mellow.db`, restart, and register again to claim owner status with the console confirmation code. |
