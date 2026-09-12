#!/usr/bin/env bash
set -e

# Change directory to the script's folder
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$SCRIPT_DIR"

echo "========================================================"
echo "              Mellow Server Launcher                    "
echo "========================================================"
echo ""

# Check for Node.js
if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js is not installed or not in PATH!"
    echo "Please download and install Node.js 22.5.0 or higher:"
    echo "  https://nodejs.org/ (or via nvm / package manager)"
    echo ""
    exit 1
fi

# Check Node.js version (v22.5.0+ recommended for node:sqlite)
if ! node -e "const [maj, min] = process.versions.node.split('.').map(Number); if (maj < 22 || (maj === 22 && min < 5)) process.exit(1);" >/dev/null 2>&1; then
    NODE_VER="$(node -v 2>/dev/null || echo 'unknown')"
    echo "[WARNING] Current Node.js version is ${NODE_VER}."
    echo "Mellow requires Node.js v22.5.0+ for native SQLite (node:sqlite)."
    echo "If you experience database errors, please upgrade Node.js."
    echo ""
fi

# Check for --install / -i flag, or missing/incomplete dependencies
FORCE_INSTALL=0
if [[ "$1" == "--install" || "$1" == "-i" ]]; then
    FORCE_INSTALL=1
elif [[ ! -d "node_modules" || ! -d "node_modules/express" || ! -d "node_modules/ws" || ! -d "node_modules/multer" || ! -d "node_modules/selfsigned" || ! -d "node_modules/emoji-picker-element" ]]; then
    FORCE_INSTALL=1
fi

if [[ "$FORCE_INSTALL" -eq 1 ]]; then
    echo "[INFO] Dependencies missing or incomplete."
    echo "[INFO] Auto-downloading and installing dependencies via npm..."
    npm install
    echo "[SUCCESS] Dependencies downloaded and installed successfully."
    echo ""
fi

echo "[INFO] Starting Mellow Server..."
echo ""
exec npm start
