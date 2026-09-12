# ==============================================================================
# Mellow Server Dockerfile
# Optimized for lightweight production deployment (ZimaOS / CasaOS / Linux)
# ==============================================================================

FROM node:22-alpine

# Set production environment
ENV NODE_ENV=production \
    PORT=6767 \
    DATA_DIR=/app/data

WORKDIR /app

# Install dependencies first (leverages Docker layer cache)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy server code and public assets
COPY server.js ./
COPY server/ ./server/
COPY public/ ./public/

# Ensure persistent data directories exist
RUN mkdir -p /app/data/uploads /app/data/certs

# Expose HTTPS web/WebSocket port (6767) and LAN discovery UDP port (6768)
EXPOSE 6767/tcp
EXPOSE 6768/udp

# Declare persistent volume for SQLite DB, uploads, and SSL certificates
VOLUME ["/app/data"]

# Built-in healthcheck verifying HTTPS responder
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const https = require('https'); const req = https.request({ host: '127.0.0.1', port: process.env.PORT || 6767, path: '/', rejectUnauthorized: false }, res => process.exit(res.statusCode < 500 ? 0 : 1)); req.on('error', () => process.exit(1)); req.end();"

# Start Mellow Server
CMD ["node", "server.js"]
