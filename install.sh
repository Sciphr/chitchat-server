#!/usr/bin/env bash
set -euo pipefail

# ─── ChitChat Server Installer ───────────────────────────────────────
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Sciphr/chitchat/main/install.sh | sudo bash
#
# Or with a specific version:
#   curl -fsSL https://raw.githubusercontent.com/Sciphr/chitchat/main/install.sh | sudo bash -s -- v1.0.0
# ──────────────────────────────────────────────────────────────────────

REPO="Sciphr/chitchat"
APP_DIR="/opt/chitchat"
DATA_DIR="/var/lib/chitchat"
SERVICE_USER="chitchat"
SERVICE_NAME="chitchat"
NODE_MAJOR=20

LIVEKIT_CONFIG="/etc/livekit.yaml"
LIVEKIT_SERVICE="livekit-server"
LIVEKIT_PORT=7880

BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[32m"
CYAN="\033[36m"
RED="\033[31m"
YELLOW="\033[33m"
MAGENTA="\033[35m"
RESET="\033[0m"

info()  { echo -e "${CYAN}  ▸${RESET} $1"; }
ok()    { echo -e "${GREEN}  ✓${RESET} $1"; }
warn()  { echo -e "${YELLOW}  !${RESET} $1"; }
fail()  { echo -e "${RED}  ✗${RESET} $1"; exit 1; }

# Generate a random alphanumeric string
random_string() {
  local len="${1:-32}"
  head -c 256 /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c "$len"
}

# ─── Pre-flight checks ───────────────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
  fail "This installer must be run as root. Try: sudo bash install.sh"
fi

if [ "$(uname -s)" != "Linux" ]; then
  fail "This installer only supports Linux. Got: $(uname -s)"
fi

for cmd in curl git; do
  if ! command -v "$cmd" &> /dev/null; then
    info "Installing ${cmd}..."
    if command -v apt-get &> /dev/null; then
      apt-get update -qq && apt-get install -y -qq "$cmd" > /dev/null
    elif command -v yum &> /dev/null; then
      yum install -y -q "$cmd" > /dev/null
    elif command -v dnf &> /dev/null; then
      dnf install -y -q "$cmd" > /dev/null
    else
      fail "Could not install ${cmd}. Please install it manually."
    fi
  fi
done

# Build tools are required for native addons (better-sqlite3)
if ! command -v g++ &> /dev/null || ! command -v make &> /dev/null; then
  info "Installing build tools (g++, make, python3)..."
  if command -v apt-get &> /dev/null; then
    apt-get update -qq && apt-get install -y -qq build-essential python3 > /dev/null
  elif command -v dnf &> /dev/null; then
    dnf install -y -q gcc-c++ make python3 > /dev/null
  elif command -v yum &> /dev/null; then
    yum install -y -q gcc-c++ make python3 > /dev/null
  else
    fail "Could not install build tools. Please install g++, make, and python3 manually."
  fi
  ok "Build tools installed"
else
  ok "Build tools available"
fi

# ─── Banner ───────────────────────────────────────────────────────────

echo ""
echo -e "${MAGENTA}${BOLD}  ╔══════════════════════════════════════╗${RESET}"
echo -e "${MAGENTA}${BOLD}  ║     ChitChat Server Installer        ║${RESET}"
echo -e "${MAGENTA}${BOLD}  ╚══════════════════════════════════════╝${RESET}"
echo ""
info "Architecture: $(uname -m)"

# ─── Install Node.js if needed ────────────────────────────────────────

if command -v node &> /dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge "$NODE_MAJOR" ]; then
    ok "Node.js $(node -v) already installed"
  else
    warn "Node.js $(node -v) is too old (need v${NODE_MAJOR}+), upgrading..."
    NEED_NODE=true
  fi
else
  NEED_NODE=true
fi

if [ "${NEED_NODE:-}" = "true" ]; then
  info "Installing Node.js ${NODE_MAJOR}..."

  if command -v apt-get &> /dev/null; then
    # Debian/Ubuntu — use NodeSource
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - > /dev/null 2>&1
    apt-get install -y -qq nodejs > /dev/null
  elif command -v yum &> /dev/null || command -v dnf &> /dev/null; then
    # RHEL/CentOS/Fedora
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - > /dev/null 2>&1
    if command -v dnf &> /dev/null; then
      dnf install -y -q nodejs > /dev/null
    else
      yum install -y -q nodejs > /dev/null
    fi
  else
    fail "Unsupported package manager. Please install Node.js ${NODE_MAJOR} manually."
  fi

  ok "Node.js $(node -v) installed"
fi

# ─── Install LiveKit server ──────────────────────────────────────────

if command -v livekit-server &> /dev/null; then
  ok "LiveKit server already installed"
else
  info "Installing LiveKit server..."

  # Detect architecture
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64|amd64)  LK_ARCH="amd64" ;;
    aarch64|arm64) LK_ARCH="arm64" ;;
    armv7l)        LK_ARCH="arm" ;;
    *)             fail "Unsupported architecture for LiveKit: ${ARCH}" ;;
  esac

  # Get latest LiveKit release
  LK_VERSION=$(curl -fsSL "https://api.github.com/repos/livekit/livekit/releases/latest" 2>/dev/null \
    | grep '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' || echo "")

  if [ -z "$LK_VERSION" ]; then
    fail "Could not determine latest LiveKit version"
  fi

  # Strip the leading 'v' for the download URL filename
  LK_VER_NUM="${LK_VERSION#v}"

  LK_URL="https://github.com/livekit/livekit/releases/download/${LK_VERSION}/livekit_${LK_VER_NUM}_linux_${LK_ARCH}.tar.gz"

  info "Downloading LiveKit ${LK_VERSION} (${LK_ARCH})..."
  curl -fsSL "$LK_URL" -o /tmp/livekit.tar.gz
  tar -xzf /tmp/livekit.tar.gz -C /usr/local/bin/ livekit-server
  chmod +x /usr/local/bin/livekit-server
  rm -f /tmp/livekit.tar.gz

  ok "LiveKit server installed ($(livekit-server --version 2>&1 | head -1 || echo "${LK_VERSION}"))"
fi

# ─── Configure LiveKit ───────────────────────────────────────────────

if [ -f "$LIVEKIT_CONFIG" ]; then
  ok "LiveKit config already exists, preserving"

  # Read existing API key and secret from config
  LK_API_KEY=$(grep -E '^\s+\S+:' "$LIVEKIT_CONFIG" | head -1 | sed -E 's/^\s+(\S+):.*/\1/' || echo "")
  LK_API_SECRET=$(grep -E '^\s+\S+:' "$LIVEKIT_CONFIG" | head -1 | sed -E 's/^\s+\S+:\s*(\S+).*/\1/' || echo "")
else
  info "Generating LiveKit API credentials..."

  LK_API_KEY="API$(random_string 12)"
  LK_API_SECRET="$(random_string 36)"

  cat > "$LIVEKIT_CONFIG" << LKEOF
port: ${LIVEKIT_PORT}
rtc:
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
keys:
  ${LK_API_KEY}: ${LK_API_SECRET}
logging:
  level: info
LKEOF

  chmod 600 "$LIVEKIT_CONFIG"
  ok "LiveKit config written to ${LIVEKIT_CONFIG}"
fi

# ─── LiveKit systemd service ─────────────────────────────────────────

if [ ! -f "/etc/systemd/system/${LIVEKIT_SERVICE}.service" ]; then
  info "Installing LiveKit systemd service..."

  cat > "/etc/systemd/system/${LIVEKIT_SERVICE}.service" << EOF
[Unit]
Description=LiveKit WebRTC Server
After=network.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/livekit-server --config ${LIVEKIT_CONFIG}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${LIVEKIT_SERVICE}
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$LIVEKIT_SERVICE" --quiet
  ok "LiveKit systemd service installed and enabled"
else
  ok "LiveKit systemd service already exists"
fi

# Start/restart LiveKit
if systemctl is-active --quiet "$LIVEKIT_SERVICE" 2>/dev/null; then
  info "Restarting LiveKit server..."
  systemctl restart "$LIVEKIT_SERVICE"
else
  info "Starting LiveKit server..."
  systemctl start "$LIVEKIT_SERVICE"
fi

sleep 2

if systemctl is-active --quiet "$LIVEKIT_SERVICE"; then
  ok "LiveKit server is running on port ${LIVEKIT_PORT}"
else
  warn "LiveKit may have failed to start. Check: journalctl -u ${LIVEKIT_SERVICE} -f"
fi

# ─── Determine version ───────────────────────────────────────────────

VERSION="${1:-latest}"

if [ "$VERSION" = "latest" ]; then
  info "Fetching latest release..."
  VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null | grep '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' || echo "")

  # Fall back to latest commit on main if no releases exist
  if [ -z "$VERSION" ]; then
    VERSION="main"
    info "No releases found, using main branch"
  fi
fi

ok "Version: ${VERSION}"

# ─── Download application ────────────────────────────────────────────

if [ -d "${APP_DIR}/.git" ]; then
  # Existing installation — pull updates
  info "Updating existing installation..."
  cd "$APP_DIR"
  git fetch --all --quiet
  if [ "$VERSION" = "main" ]; then
    git checkout main --quiet
    git pull --quiet
  else
    git checkout "$VERSION" --quiet
  fi
  ok "Updated to ${VERSION}"
else
  # Fresh install — clone the repo
  info "Downloading ChitChat..."
  if [ -d "$APP_DIR" ]; then
    rm -rf "$APP_DIR"
  fi

  if [ "$VERSION" = "main" ]; then
    git clone --quiet --depth 1 "https://github.com/${REPO}.git" "$APP_DIR"
  else
    git clone --quiet --depth 1 --branch "$VERSION" "https://github.com/${REPO}.git" "$APP_DIR"
  fi
  ok "Downloaded successfully"
fi

# ─── Install dependencies & build ────────────────────────────────────

info "Installing dependencies (this may take a minute)..."
cd "${APP_DIR}/server"
npm ci --omit=dev --quiet 2>&1 | tail -1

ok "Dependencies installed"

info "Building server..."
npm run build --quiet 2>&1 | tail -1
ok "Build complete"

# ─── Create system user ──────────────────────────────────────────────

if ! id "$SERVICE_USER" &>/dev/null; then
  info "Creating system user: ${SERVICE_USER}"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  ok "System user created"
else
  ok "System user already exists"
fi

# ─── Create data directories ─────────────────────────────────────────

info "Setting up directories..."

mkdir -p "$DATA_DIR"
mkdir -p "${DATA_DIR}/uploads"

chown -R "${SERVICE_USER}:${SERVICE_USER}" "$DATA_DIR"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "$APP_DIR"
ok "Data directory: ${DATA_DIR}"

# ─── Run first-time setup ────────────────────────────────────────────

# Stop existing service if running
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  info "Stopping existing ${SERVICE_NAME} service..."
  systemctl stop "$SERVICE_NAME"
fi

# Check if config already exists (upgrade scenario)
if [ -f "${DATA_DIR}/config.json" ]; then
  ok "Existing config found, skipping setup"
else
  info "Running first-time setup..."
  echo ""

  # Run setup interactively as the chitchat user
  cd "$DATA_DIR"
  sudo -u "$SERVICE_USER" node "${APP_DIR}/server/dist/index.js" --setup
fi

# ─── Auto-configure LiveKit in ChitChat config ───────────────────────

info "Configuring LiveKit connection..."

# Detect the server's IP address for the LiveKit URL
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")
LK_WS_URL="ws://${SERVER_IP}:${LIVEKIT_PORT}"

# Use node to safely update JSON config
node -e "
  const fs = require('fs');
  const configPath = '${DATA_DIR}/config.json';
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // Only set LiveKit values if not already configured
  if (!config.livekit) config.livekit = {};
  if (!config.livekit.url)       config.livekit.url = '${LK_WS_URL}';
  if (!config.livekit.apiKey)    config.livekit.apiKey = '${LK_API_KEY}';
  if (!config.livekit.apiSecret) config.livekit.apiSecret = '${LK_API_SECRET}';

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
"

ok "LiveKit configured (${LK_WS_URL})"

# ─── Install systemd service ─────────────────────────────────────────

info "Installing systemd service..."

cat > "/etc/systemd/system/${SERVICE_NAME}.service" << EOF
[Unit]
Description=ChitChat Server
After=network.target ${LIVEKIT_SERVICE}.service
Wants=network-online.target
Requires=${LIVEKIT_SERVICE}.service

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${DATA_DIR}
ExecStart=$(command -v node) ${APP_DIR}/server/dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATA_DIR}
ReadOnlyPaths=${APP_DIR}
PrivateTmp=true

# Environment
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" --quiet
ok "Systemd service installed and enabled"

# ─── Start the service ───────────────────────────────────────────────

info "Starting ChitChat server..."
systemctl start "$SERVICE_NAME"

# Wait a moment and check status
sleep 3

if systemctl is-active --quiet "$SERVICE_NAME"; then
  ok "Server is running!"
else
  warn "Server may have failed to start. Check: journalctl -u ${SERVICE_NAME} -f"
fi

# ─── Done ─────────────────────────────────────────────────────────────

# Read port from config
PORT=$(grep '"port"' "${DATA_DIR}/config.json" 2>/dev/null | head -1 | sed -E 's/.*: *([0-9]+).*/\1/' || echo "3001")

echo ""
echo -e "${GREEN}${BOLD}  ════════════════════════════════════════${RESET}"
echo -e "${GREEN}${BOLD}  Installation complete!${RESET}"
echo -e "${GREEN}${BOLD}  ════════════════════════════════════════${RESET}"
echo ""
echo -e "  ${BOLD}Your server is running at:${RESET}"
echo -e "  ${CYAN}http://${SERVER_IP}:${PORT}${RESET}"
echo ""
echo -e "  ${BOLD}LiveKit (voice/video):${RESET}"
echo -e "  ${CYAN}${LK_WS_URL}${RESET}"
echo ""
echo -e "  ${DIM}Useful commands:${RESET}"
echo -e "  ${DIM}  Status:   sudo systemctl status ${SERVICE_NAME}${RESET}"
echo -e "  ${DIM}  Logs:     sudo journalctl -u ${SERVICE_NAME} -f${RESET}"
echo -e "  ${DIM}  Restart:  sudo systemctl restart ${SERVICE_NAME}${RESET}"
echo -e "  ${DIM}  Stop:     sudo systemctl stop ${SERVICE_NAME}${RESET}"
echo -e "  ${DIM}  Config:   ${DATA_DIR}/config.json${RESET}"
echo -e "  ${DIM}  Data:     ${DATA_DIR}/${RESET}"
echo ""
echo -e "  ${DIM}LiveKit:${RESET}"
echo -e "  ${DIM}  Status:   sudo systemctl status ${LIVEKIT_SERVICE}${RESET}"
echo -e "  ${DIM}  Logs:     sudo journalctl -u ${LIVEKIT_SERVICE} -f${RESET}"
echo -e "  ${DIM}  Config:   ${LIVEKIT_CONFIG}${RESET}"
echo ""
echo -e "  ${BOLD}Clients only need your server address to connect:${RESET}"
echo -e "  ${CYAN}http://${SERVER_IP}:${PORT}${RESET}"
echo -e "  ${DIM}(LiveKit URL is auto-discovered by the client)${RESET}"
echo ""
echo -e "  ${DIM}To update later, run this installer again.${RESET}"
echo ""
