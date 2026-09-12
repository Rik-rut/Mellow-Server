# Mellow Server

A private chat and voice calling server for your home network.

Mellow lets you run your own private Discord-style communication server on your local Wi-Fi or home network. It requires no internet connection, no paid subscriptions, and no cloud accounts. All your messages, files, and calls stay inside your home.

---

## How to Run the Server

Choose the method for your system:

### Option 1: Windows (Easiest)

1. Make sure you have Node.js installed (version 22.5 or newer from [nodejs.org](https://nodejs.org/)).
2. Double-click the file named **`start.bat`**.
3. A window will open, automatically install any needed files, and start your server.
4. Keep that window open while you want the server to run.

### Option 2: Mac or Linux

1. Make sure you have Node.js installed (version 22.5 or newer from [nodejs.org](https://nodejs.org/)).
2. Open your terminal in the Mellow-Server folder.
3. Run this command:
   ```bash
   ./start.sh
   ```
   *(Or type `bash start.sh` and press Enter).*
4. The script will automatically install any needed files and start your server.

### Option 3: ZimaOS or CasaOS (Home Server)

You can run Mellow on your ZimaOS or CasaOS home server using Docker:

#### Method A: 1-Click Import in ZimaOS App Store
1. In your ZimaOS or CasaOS dashboard, open the **App Store**.
2. Click **Custom Install** (top right) -> click **Import**.
3. Paste the contents of `docker-compose.yml` (or upload the file).
4. Click **Install**.

#### Method B: Via Server Terminal
1. Copy or clone the Mellow-Server folder to your server.
2. In your server terminal, navigate to the folder and run:
   ```bash
   sudo docker compose up -d --build
   ```
3. The server will build and run in the background.

---

## How to Connect from Your Phone, Tablet, or PC

Once the server is running, anyone connected to the same home Wi-Fi or network can use it.

### 1. Find Your Server Computer IP Address
- **On Windows**: Open Command Prompt, type `ipconfig`, and look for your IPv4 Address (for example: `192.168.1.5`).
- **On Mac**: Open System Settings -> Wi-Fi -> Details, and find your IP address.
- **On ZimaOS**: Use your ZimaOS web dashboard IP address.

### 2. Open the App in Any Web Browser
Open Chrome, Safari, Edge, or Firefox on any device and go to:
```text
https://YOUR-SERVER-IP:6767
```
*(Example: `https://192.168.1.5:6767`, or `https://localhost:6767` if you are on the same computer).*

### 3. Accept the Browser Security Prompt (First Visit Only)
Because Mellow creates its own secure private connection for your home network, your browser will show a warning saying the connection is not recognized:
- **Chrome / Edge**: Click **Advanced**, then click **Proceed to (unsafe)**.
- **Firefox**: Click **Advanced**, then click **Accept the Risk and Continue**.
- **Safari / iPhone / iPad**: Tap **Show Details**, then tap **Visit this website**.

This is completely normal for private home servers.

### 4. Create the First Account (Server Owner)
1. Click **Register** and choose a username and password.
2. When you submit, look at your server window. It will print a 6-digit confirmation code:
   ```text
   [Mellow] "yourname" wants to register. Confirmation code: 123456
   ```
   *(If you are running on ZimaOS or Docker, type `sudo docker logs -f mellow` to see the code).*
3. Type the 6-digit code into your browser and click **Confirm code**.
4. You are now the Server Owner. Future family members or friends who register can be approved directly by you in the app under **Admin Dashboard**.

---

## Connecting Outside Your Home (For Friends and Family)

If you want friends or family members who live elsewhere to chat and call on your server, you do not need to open router ports or pay for server hosting. You can use any of these free methods:

### Method 1: Tailscale (Recommended for Phones, Tablets, and PCs)

Tailscale creates a secure, private connection between your devices.

1. Install the free **Tailscale** app on your server computer and on your family member's device (iPhone, Android, Windows, Mac, or Linux) from [tailscale.com](https://tailscale.com/).
2. Log in with the same account (or use Tailscale Share to invite their account).
3. Copy your server's Tailscale IP address (it looks like `100.x.y.z`).
4. On their phone or computer, they open a browser and go to:
   ```text
   https://YOUR-TAILSCALE-IP:6767
   ```
5. They accept the security prompt once, and they are in.

### Method 2: Radmin VPN (Best for Windows Gaming Groups)

Radmin VPN connects Windows PCs together like a virtual local network.

1. Download and install free **Radmin VPN** from [radmin-vpn.com](https://www.radmin-vpn.com/) on the server PC and on your friend's PC.
2. On your server PC, click **Network -> Create network**, and set a network name and password.
3. Your friends open Radmin VPN, click **Network -> Join network**, and enter that name and password.
4. They copy your Radmin VPN IP address (it starts with `26.x.y.z`) and open:
   ```text
   https://YOUR-RADMIN-IP:6767
   ```

### Method 3: Cloudflare Tunnel (No App Required on Friend's Devices)

Cloudflare Tunnel lets you create a real web link (like `https://chat.yourdomain.com`) so visitors can join directly without installing any VPN app.

1. Set up a free **Cloudflare Tunnel** in your Cloudflare dashboard (under Zero Trust -> Networks -> Tunnels).
2. Point the tunnel destination to your local server:
   - Service: `HTTPS`
   - URL: `localhost:6767`
   - Additional Settings -> TLS: Enable **No TLS Verify** (so Cloudflare accepts Mellow's local certificate).
3. Cloudflare gives you a secure public web link.
4. Send that web link to your friends and family. Anyone can click it from any phone or computer and chat immediately with a green padlock.

---

## What You Can Do with Mellow

- **Text Chat and Channels**: Create discussion channels for different topics and send direct messages to friends.
- **Voice and Video Calls**: Hop into voice channels with low lag, turn on your camera, or view multiple people on screen at once.
- **Screen Sharing with Audio**: Share your screen or individual app windows with sound for watching videos together or playing games.
- **Background Noise Removal**: Built-in audio filters clean up background noise from fans, keyboards, and pets.
- **File and Photo Sharing**: Drag and drop pictures, videos, and files straight into the chat.
- **Works Without Internet**: If your home internet goes down, your local chat and calls continue working as long as your Wi-Fi router is on.

---

## Keeping Your Data and Messages Safe

All your settings, user accounts, uploaded pictures, and chat history are stored inside one single folder:
```text
data/
```

- **To Back Up Everything**: Simply make a copy of the `data/` folder and save it to a USB drive or cloud backup.
- **To Move to ZimaOS**: Copy your existing `data/` files into `/DATA/AppData/mellow/data/` on your ZimaOS drive. All your previous conversations and accounts will automatically be there.
- **To Start Fresh**: Stop the server, delete the `data/mellow.db` file, and start the server again.

---

## Simple Troubleshooting

| Problem | Simple Solution |
|---|---|
| The web page will not load | Make sure your phone or laptop is on the same Wi-Fi network as the server computer. Double-check that you typed `https://` at the start of the address, not `http://`. |
| Microphone or camera will not turn on | Browsers require a secure connection to use microphones and cameras. Make sure the address starts with `https://` and that you accepted the browser certificate prompt. |
| Where do I find the 6-digit registration code? | Look at the black terminal window on the computer running the server. If using Docker, run `sudo docker logs -f mellow`. |
| "Node.js version" error when starting | Mellow requires Node.js version 22.5 or newer. Download the current LTS version from [nodejs.org](https://nodejs.org/) and run the launcher again. |
| Other computers cannot connect on Windows | Windows Firewall may be blocking the connection. Allow Node.js through Windows Defender Firewall, or allow port 6767. |

---

## Technical Details for Advanced Users

- **Backend**: Node.js, Express, WebSockets (`ws`), native `node:sqlite` in WAL journal mode.
- **Audio and Video**: WebRTC mesh peer-to-peer connections.
- **Noise Suppression**: Client-side WebAssembly models (DeepFilterNet3 and RNNoise).
- **Default Ports**: Port 6767 (HTTPS web client and WebSockets), Port 6768 (UDP local network auto-discovery).
