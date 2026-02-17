# ChitChat Server

Node/Express backend for ChitChat.

## Quick Start

1. Install dependencies:

```bash
npm ci
```

2. Build:

```bash
npm run build
```

3. Run:

```bash
npm run start
```

Default local URL: `http://127.0.0.1:3001`

## Linux Installation (Guided)

For customers, this is the main entry command:

```bash
curl -fsSL https://raw.githubusercontent.com/Sciphr/chitchat-server/main/install.sh | sudo bash
```

Install a specific release tag:

```bash
curl -fsSL https://raw.githubusercontent.com/Sciphr/chitchat-server/main/install.sh | sudo bash -s -- v0.2.1
```

What this guided installer does:

- Prompts for install mode first:
  - Native Linux service (systemd)
  - Docker Compose
- Then asks mode-relevant follow-up questions (for example Docker host port and optional ClamAV).
- Runs first-time setup prompts (admin account, server settings, port, etc.) on first install.
- In Docker mode, deploys a bundled LiveKit container and auto-wires `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`.

Common installer flags:

- `--mode native|docker`
- `--docker-port 3001` (Docker mode host port)
- `--with-clamav` force ClamAV install/config
- `--skip-clamav` skip ClamAV install/config
- `--non-interactive` with `--admin-email`, `--admin-username`, `--admin-password`
- `--data-dir /path`

Example non-interactive Docker install:

```bash
curl -fsSL https://raw.githubusercontent.com/Sciphr/chitchat-server/main/install.sh | sudo bash -s -- --mode docker --non-interactive --admin-email admin@example.com --admin-username admin --admin-password 'change-me-now'
```

## Optional: Run With Docker

This is an alternate install/run path. The normal `npm` workflow and Linux installer can still be used.

1. Create env file:

```bash
cp .env.example .env
```

2. Build and run:

```bash
docker compose up -d --build
```

With ClamAV upload scanning enabled:

```bash
FILES_AV_ENABLED=true docker compose --profile clamav up -d --build
```

3. Stop:

```bash
docker compose down
```

Notes:

- App data (including SQLite DB and uploads) is stored in a named Docker volume: `chitchat_data`.
- ClamAV signatures are stored in a named Docker volume: `clamav_db`.
- Container maps `${HOST_PORT:-3001}:3001` (default host port `3001`).
- Bundled LiveKit runs in Docker and maps:
  - TCP `${LIVEKIT_PORT:-7880}`
  - UDP `${LIVEKIT_UDP_PORT_START:-50000}` to `${LIVEKIT_UDP_PORT_END:-50100}`
- When using Docker ClamAV, set `FILES_AV_CLAMAV_HOST=clamav` (already the compose default).
- To inspect logs: `docker compose logs -f chitchat`

## Docker Operations

Docker mode works well for production, but operators should handle these explicitly:

1. Firewall/network
   - Open app port (`HOST_PORT`, default `3001`), LiveKit TCP port (`7880`), and LiveKit UDP range (`50000-50100` by default).
2. Backups
   - Back up Docker volumes regularly:
     - `chitchat_data` (database/uploads/config)
     - `clamav_db` (ClamAV signatures; optional to back up, but helps startup speed)
3. Updates
   - Re-run installer or pull latest repo + `docker compose up -d --build`.
4. Logs/monitoring
   - Use `docker compose logs -f chitchat livekit clamav` and container health checks.
5. Secrets
   - Protect `.env` and `deploy/livekit/livekit.yaml` permissions because they contain API secrets.
6. Reverse proxy/TLS
   - Keep TLS at Nginx/Caddy/Traefik/Cloudflare; app containers can stay on HTTP internally.

## First Deploy Checklist

1. Keep the app behind a reverse proxy (recommended for production).
2. Decide TLS ownership:
   - Admin/infrastructure should manage certs, renewals, and DNS.
   - App/server installer should not force TLS automatically.
3. If using HTTPS, set in Admin UI:
   - `Trust Reverse Proxy = enabled`
   - `LiveKit URL = wss://...` (not `ws://...`)
4. Lock firewall to required ports only.
5. Configure password reset email (SMTP) if you want reset flow enabled.
6. Enable backups for DB and uploaded files.

## TLS / Reverse Proxy

ChitChat can run directly on HTTP for local/LAN usage, but production should use TLS at the proxy.

Common setup:

- Public app URL: `https://chat.example.com`
- Proxy -> local server: `http://127.0.0.1:3001`

After proxy/TLS is live:

1. In Admin > Configuration > Security:
   - enable `Trust Reverse Proxy`
2. In Admin > Configuration > CORS:
   - add your HTTPS origin(s), for example `https://chat.example.com`
3. In Admin > Configuration > Media:
   - set `LiveKit URL` to your secure websocket endpoint (`wss://...`)

## Password Reset Email (SMTP)

Password reset endpoints only send mail when SMTP credentials are set.

Required environment variables:

- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

Optional (defaults to Gmail SMTP):

- `SMTP_HOST` (default: `smtp.gmail.com`)
- `SMTP_PORT` (default: `587`)
- `SMTP_SECURE` (default: `false`, STARTTLS)

For Gmail:

1. Enable 2-Step Verification on the Google account.
2. Create an App Password.
3. Use that app password in `SMTP_PASS` (not your normal account password).

## Malware Scanning For Uploads (Optional)

ChitChat can scan uploads before they are written to disk using ClamAV (`clamd`).

Environment variables:

- `FILES_AV_ENABLED=true|false` (default: `false`)
- `FILES_AV_PROVIDER=clamav` (current supported provider)
- `FILES_AV_CLAMAV_HOST` (default: `127.0.0.1`)
- `FILES_AV_CLAMAV_PORT` (default: `3310`)
- `FILES_AV_TIMEOUT_MS` (default: `15000`)
- `FILES_AV_FAIL_CLOSED=true|false` (default: `true`)

Behavior:

- If malware is detected, upload is rejected.
- If scanner is unavailable:
  - `FILES_AV_FAIL_CLOSED=true`: upload is rejected (safer).
  - `FILES_AV_FAIL_CLOSED=false`: upload is allowed and warning is logged.

## Useful Endpoints

- Health: `GET /api/health`
- Public server info: `GET /api/server/info`
- Admin UI: `GET /admin`

## Dev

- Watch mode:

```bash
npm run dev
```
