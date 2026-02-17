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

## Useful Endpoints

- Health: `GET /api/health`
- Public server info: `GET /api/server/info`
- Admin UI: `GET /admin`

## Dev

- Watch mode:

```bash
npm run dev
```
