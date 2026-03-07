# ChitChat Server - Sciphr

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

- Installs the native Linux service (`systemd`) deployment.
- Installs and configures the bundled LiveKit `systemd` service.
- Optionally installs and configures ClamAV for upload scanning.
- Runs first-time setup prompts (admin account, server settings, port, etc.) on first install.

Common installer flags:

- `--with-clamav` force ClamAV install/config
- `--skip-clamav` skip ClamAV install/config
- `--non-interactive`
- `--server-name "My ChitChat Server"`
- `--data-dir /path`

Example non-interactive native install:

```bash
curl -fsSL https://raw.githubusercontent.com/Sciphr/chitchat-server/main/install.sh | sudo bash -s -- --non-interactive --server-name "My ChitChat Server" --skip-clamav
```

For Docker or Portainer deployments, use [`docker-compose.yml`](./docker-compose.yml) or [`portainer-stack.yml`](./portainer-stack.yml) instead of `install.sh`.

## Docker Hub / Portainer Install

Pre-built images are published to Docker Hub at [`sciphr/chitchat-server`](https://hub.docker.com/r/sciphr/chitchat-server).

### Portainer (Recommended for Unraid and similar)

There are two ways to deploy via Portainer. **Option A (web editor paste)** is the quickest - no repo connection needed.

---

#### Option A: Paste directly into the Portainer web editor

1. In Portainer, go to **Stacks > Add stack > Web editor**
2. Paste the YAML below into the editor
3. Update the three values marked `# <-- CHANGE THIS` (JWT secret + LiveKit key/secret)
4. Click **Deploy the stack**

```yaml
# ChitChat Server - Portainer Stack
#
# HOW TO DEPLOY:
#   1. In Portainer, go to Stacks > Add Stack
#   2. Paste this entire file into the Web editor
#   3. Update the values marked with  <-- CHANGE THIS  before deploying
#   4. Click "Deploy the stack"
#
# IMPORTANT: LIVEKIT_API_KEY and LIVEKIT_API_SECRET seed the initial
# persisted config and are used as fallback if no saved config exists.
# Change them to long random strings before first deploy.

services:
  chitchat:
    image: sciphr/chitchat-server:latest
    restart: unless-stopped
    environment:
      PORT: "3001"
      DB_PATH: /app/data/chitchat.db
      DATA_DIR: /app/data

      # -- Authentication ---------------------------------------------------
      # Generate a strong secret, e.g.: openssl rand -hex 32
      JWT_SECRET: "change-me-to-a-long-random-secret" # <-- CHANGE THIS

      # -- LiveKit (must match the livekit service below) -------------------
      # Leave this as-is for direct IP/hostname installs. Clients will
      # automatically use the same host they used for ChitChat on port 7880.
      # Only change this for HTTPS/reverse proxy or a separate public LiveKit host.
      LIVEKIT_URL: ws://livekit:7880
      LIVEKIT_API_KEY: "devkey" # <-- CHANGE THIS
      LIVEKIT_API_SECRET: "devsecret" # <-- CHANGE THIS

      # -- Access control ---------------------------------------------------
      # For a public server set this to your URL, e.g. https://chat.example.com
      # Use * to allow all origins (fine for private/LAN installs)
      CORS_ALLOWED_ORIGINS: "*"
      CORS_ALLOW_NO_ORIGIN: "true"

      # -- Antivirus (ClamAV - disabled by default, see README for optional setup) --
      # FILES_AV_ENABLED: "true"
      # FILES_AV_PROVIDER: clamav
      # FILES_AV_CLAMAV_HOST: clamav
      # FILES_AV_CLAMAV_PORT: "3310"
      # FILES_AV_TIMEOUT_MS: "15000"
      # FILES_AV_FAIL_CLOSED: "true"

      # -- Optional: Password reset emails (SMTP) ---------------------------
      # SMTP_USER: you@example.com
      # SMTP_PASS: your-smtp-password
      # SMTP_FROM: you@example.com
      # SMTP_HOST: smtp.gmail.com
      # SMTP_PORT: "587"
      # SMTP_SECURE: "false"

      # -- Optional: GIF search via GIPHY -----------------------------------
      # GIPHY_ENABLED: "true"
      # GIPHY_API_KEY: your-giphy-api-key
      # GIPHY_RATING: pg
      # GIPHY_MAX_RESULTS: "20"

      # -- Optional: Strip EXIF data from uploaded images -------------------
      # FILES_STRIP_IMAGE_EXIF: "true"

    depends_on:
      - livekit
    ports:
      - "3001:3001"
    volumes:
      - chitchat_data:/app/data

  livekit:
    image: livekit/livekit-server:latest
    restart: unless-stopped
    # The runtime config is assembled at container start. Saved ChitChat config
    # in /app/data/config.json takes priority so Admin UI credential changes
    # persist across updates. The env values below are bootstrap/fallback only.
    entrypoint: ["/bin/sh", "-c"]
    environment:
      LIVEKIT_API_KEY: "devkey" # <-- CHANGE THIS
      LIVEKIT_API_SECRET: "devsecret" # <-- CHANGE THIS
      LIVEKIT_CONFIG: |
        port: 7880
        rtc:
          port_range_start: 50000
          port_range_end: 50100
          use_external_ip: true
        logging:
          level: info

        # -- TURN relay (optional, for users behind strict firewalls/NAT) ---
        # Requires a domain with a valid TLS certificate pointing to this server.
        # Uncomment and set your domain to enable:
        # turn:
        #   enabled: true
        #   domain: livekit.example.com
        #   tls_port: 5349
        #   udp_port: 3478
        #   external_tls: false
    command:
      - |
        set -eu
        BASE_CFG=/tmp/livekit-base.yaml
        RUNTIME_CFG=/tmp/livekit.yaml
        DATA_CFG=/app/data/config.json

        extract_livekit_value() {
          key="$$1"
          if [ ! -r "$$DATA_CFG" ]; then
            return 0
          fi
          sed -n '/"livekit"[[:space:]]*:[[:space:]]*{/,/^[[:space:]]*}[,]*[[:space:]]*$$/p' "$$DATA_CFG" \
            | sed -n "s/.*\"$$key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" \
            | head -n 1
        }

        printf '%s\n' "$${LIVEKIT_CONFIG:-}" > "$$BASE_CFG"
        if [ -s "$$BASE_CFG" ]; then
          awk '
            BEGIN { skip = 0 }
            /^[[:space:]]*keys:[[:space:]]*$$/ { skip = 1; next }
            skip && /^[^[:space:]]/ { skip = 0 }
            !skip { print }
          ' "$$BASE_CFG" > "$$RUNTIME_CFG"
        else
          cat > "$$RUNTIME_CFG" <<EOF
        port: 7880
        rtc:
          port_range_start: 50000
          port_range_end: 50100
          use_external_ip: true
        logging:
          level: info
        EOF
        fi

        LK_API_KEY="$$(extract_livekit_value apiKey)"
        LK_API_SECRET="$$(extract_livekit_value apiSecret)"
        if [ -z "$$LK_API_KEY" ]; then LK_API_KEY="$${LIVEKIT_API_KEY:-}"; fi
        if [ -z "$$LK_API_SECRET" ]; then LK_API_SECRET="$${LIVEKIT_API_SECRET:-}"; fi
        if [ -n "$$LK_API_KEY" ] && [ -n "$$LK_API_SECRET" ]; then
          LK_API_KEY_ESCAPED="$$(printf '%s' "$$LK_API_KEY" | sed 's/[\"\\]/\\&/g')"
          LK_API_SECRET_ESCAPED="$$(printf '%s' "$$LK_API_SECRET" | sed 's/[\"\\]/\\&/g')"
          printf 'keys:\n  "%s": "%s"\n' "$$LK_API_KEY_ESCAPED" "$$LK_API_SECRET_ESCAPED" >> "$$RUNTIME_CFG"
        fi

        exec livekit-server --config "$$RUNTIME_CFG"
    ports:
      - "7880:7880/tcp"
      - "50000-50100:50000-50100/udp"
      - "3478:3478/udp"
      - "5349:5349/tcp"
    volumes:
      - chitchat_data:/app/data

volumes:
  chitchat_data:
```

This stack file is also available in the repo as [`portainer-stack.yml`](./portainer-stack.yml).

---

#### Option B: Connect Portainer to this repository

1. In Portainer, go to **Stacks > Add stack > Repository**
2. Set the repository URL to this repo and the compose path to `docker-compose.yml`
3. Add the following environment variables:

| Variable             | Required              | Description                                                                                                                                                                                 |
| -------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_EMAIL`        | Yes (first boot only) | Email address for the initial admin account. Ignored after first boot.                                                                                                                      |
| `ADMIN_USERNAME`     | Yes (first boot only) | Username for the initial admin account. Ignored after first boot.                                                                                                                           |
| `ADMIN_PASSWORD`     | Yes (first boot only) | Password for the initial admin account (min 10 characters). Used once to create the account, then stored as a bcrypt hash in the database. Can be removed from env vars after first deploy. |
| `LIVEKIT_API_KEY`    | Yes (for voice)       | Seeds the initial persisted value and acts as fallback if `/app/data/config.json` does not already contain a saved LiveKit key.                                                           |
| `LIVEKIT_API_SECRET` | Yes (for voice)       | Seeds the initial persisted value and acts as fallback if `/app/data/config.json` does not already contain a saved LiveKit secret.                                                        |
| `LIVEKIT_URL`        | No                    | Seeds the initial saved value. Defaults to the bundled Docker hostname `ws://livekit:7880`; clients connecting directly to ChitChat will automatically use the same host on port `7880`. |
| `HOST_PORT`          | No                    | Host port to expose the app on. Defaults to `3001`. If you change the server listening port in the Admin UI, update this published host port mapping too.                               |

> **Important:** `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` must be set before deploying. ChitChat persists them in `/app/data/config.json`, and the bundled Docker LiveKit container reads the saved values on restart. The stack env values are only bootstrap/fallback values after this change.
>
> After first boot, saved values in `/app/data/config.json` take precedence on updates, so Admin UI changes are preserved for both ChitChat and the bundled Docker LiveKit runtime.
>
> For direct self-hosting without TLS, clients can connect to `http://<server-ip>:3001` and ChitChat will advertise `ws://<same-host>:7880` for voice/video by default. Open TCP `3001`, TCP `7880`, and UDP `50000-50100`.

4. Click **Deploy the stack**

---

### First Login

On first boot the server creates a default admin account:

| Field        | Value                  |
| ------------ | ---------------------- |
| **Email**    | `admin@chitchat.local` |
| **Password** | `changeme123!`         |

Go to `/admin`, log in with these credentials, and complete the setup wizard to replace this account with your own. **Change the password immediately** - the defaults are public.

---

Text chat works immediately. For voice/video, open the required firewall ports:

- TCP `7880` (LiveKit)
- UDP `50000-50100` (LiveKit media)

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

3. Stop:

```bash
docker compose down
```

Notes:

- App data (including SQLite DB and uploads) is stored in a named Docker volume: `chitchat_data`.
- Container maps `${HOST_PORT:-3001}:3001` (default host port `3001`).
- If you change `Port` in Admin > Configuration > General, update the Docker published port mapping too or requests will stop reaching the app after restart.
- Bundled LiveKit runs in Docker and maps:
  - TCP `${LIVEKIT_PORT:-7880}`
  - UDP `${LIVEKIT_UDP_PORT_START:-50000}` to `${LIVEKIT_UDP_PORT_END:-50100}`
- For direct IP/hostname installs without TLS, clients can connect to `http://<server-ip>:${HOST_PORT:-3001}` and will automatically use `ws://<same-host>:${LIVEKIT_PORT:-7880}` for LiveKit.
- ClamAV is not included by default (see optional setup below).
- To inspect logs: `docker compose logs -f chitchat`

## Docker Operations

Docker mode works well for production, but operators should handle these explicitly:

1. Firewall/network
   - Open app port (`HOST_PORT`, default `3001`), LiveKit TCP port (`7880`), and LiveKit UDP range (`50000-50100` by default).
2. Backups
   - Back up Docker volumes regularly:
     - `chitchat_data` (database/uploads/config)
     - `clamav_db` (ClamAV signatures; only present if ClamAV is enabled - optional to back up, but helps startup speed)
3. Updates
   - Re-run installer or pull latest repo + `docker compose up -d --build`.
4. Logs/monitoring
   - Use `docker compose logs -f chitchat livekit` and container health checks (add `clamav` if enabled).
5. Secrets
   - Protect `.env`, Docker volumes, and any custom `deploy/livekit/livekit.yaml` base config because they may contain or seed API secrets.
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

ChitChat can scan uploads before they are written to disk using ClamAV (`clamd`). ClamAV is **not included by default** because its large image size (~500 MB + signature downloads) can cause timeouts during initial deployment (e.g. in Portainer).

### Adding ClamAV to a Portainer / Docker Compose stack

Add the following service to your stack and enable the env vars in the `chitchat` service:

```yaml
services:
  # ... (your existing chitchat and livekit services) ...

  clamav:
    image: clamav/clamav:stable
    restart: unless-stopped
    expose:
      - "3310"
    volumes:
      - clamav_db:/var/lib/clamav

volumes:
  # ... (your existing volumes) ...
  clamav_db:
```

Then uncomment (or add) these env vars under the `chitchat` service:

```yaml
FILES_AV_ENABLED: "true"
FILES_AV_PROVIDER: clamav
FILES_AV_CLAMAV_HOST: clamav
FILES_AV_CLAMAV_PORT: "3310"
FILES_AV_TIMEOUT_MS: "15000"
FILES_AV_FAIL_CLOSED: "true"
```

> **Note:** ClamAV downloads its signature database on first start, which can take several minutes and requires ~300 MB of disk space. Allow time for it to fully initialize before uploading files.

### Environment variables

- `FILES_AV_ENABLED=true|false` (default: `false`)
- `FILES_AV_PROVIDER=clamav` (current supported provider)
- `FILES_AV_CLAMAV_HOST` (default: `127.0.0.1`)
- `FILES_AV_CLAMAV_PORT` (default: `3310`)
- `FILES_AV_TIMEOUT_MS` (default: `15000`)
- `FILES_AV_FAIL_CLOSED=true|false` (default: `true`)

### Behavior

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
