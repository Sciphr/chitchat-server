#!/usr/bin/env bash
set -euo pipefail

# ─── ChitChat Server Installer ───────────────────────────────────────
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Sciphr/chitchat-server/main/install.sh | sudo bash
#
# Or with a specific version:
#   curl -fsSL https://raw.githubusercontent.com/Sciphr/chitchat-server/main/install.sh | sudo bash -s -- v1.0.0
# ──────────────────────────────────────────────────────────────────────

REPO="Sciphr/chitchat-server"
APP_DIR="/opt/chitchat-server"
DATA_DIR="/var/lib/chitchat"
SERVICE_USER="chitchat"
SERVICE_NAME="chitchat"
NODE_MAJOR=20
HEALTH_TIMEOUT_SECONDS=45

LIVEKIT_CONFIG="/etc/livekit.yaml"
LIVEKIT_SERVICE="livekit-server"
LIVEKIT_PORT=7880

INSTALL_CLAMAV=true
CLAMAV_DECISION_EXPLICIT=false
CLAMAV_HOST="127.0.0.1"
CLAMAV_PORT=3310
CLAMAV_FAIL_CLOSED=true
CLAMAV_TIMEOUT_MS=15000
CLAMAV_READY=false
CLAMAV_SERVICE=""

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

usage() {
  cat <<'USAGE'
Usage:
  sudo bash install.sh [version] [options]

Options:
  --non-interactive            Run first-time setup without prompts (requires admin flags)
  --admin-email <email>        Admin email for first-time setup
  --admin-username <username>  Admin username for first-time setup
  --admin-password <password>  Admin password for first-time setup
  --server-name <name>         Server name for first-time setup
  --data-dir <path>            Override persistent data directory (default: /var/lib/chitchat)
  --with-clamav                Force install/configure ClamAV upload scanning
  --skip-clamav                Do not install/configure ClamAV upload scanning
  --help                       Show this help
USAGE
}

# Generate a random alphanumeric string
random_string() {
  local len="${1:-32}"
  head -c 256 /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c "$len"
}

VERSION="latest"
NON_INTERACTIVE=false
SETUP_ADMIN_EMAIL=""
SETUP_ADMIN_USERNAME=""
SETUP_ADMIN_PASSWORD=""
SETUP_SERVER_NAME=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --non-interactive)
      NON_INTERACTIVE=true
      shift
      ;;
    --admin-email)
      [ $# -ge 2 ] || fail "--admin-email requires a value"
      SETUP_ADMIN_EMAIL="$2"
      shift 2
      ;;
    --admin-username)
      [ $# -ge 2 ] || fail "--admin-username requires a value"
      SETUP_ADMIN_USERNAME="$2"
      shift 2
      ;;
    --admin-password)
      [ $# -ge 2 ] || fail "--admin-password requires a value"
      SETUP_ADMIN_PASSWORD="$2"
      shift 2
      ;;
    --server-name)
      [ $# -ge 2 ] || fail "--server-name requires a value"
      SETUP_SERVER_NAME="$2"
      shift 2
      ;;
    --data-dir)
      [ $# -ge 2 ] || fail "--data-dir requires a value"
      DATA_DIR="$2"
      shift 2
      ;;
    --with-clamav)
      INSTALL_CLAMAV=true
      CLAMAV_DECISION_EXPLICIT=true
      shift
      ;;
    --skip-clamav)
      INSTALL_CLAMAV=false
      CLAMAV_DECISION_EXPLICIT=true
      shift
      ;;
    -*)
      fail "Unknown option: $1"
      ;;
    *)
      if [ "$VERSION" = "latest" ]; then
        VERSION="$1"
      else
        fail "Unexpected positional argument: $1"
      fi
      shift
      ;;
  esac
done

if [ "${CLAMAV_DECISION_EXPLICIT}" != "true" ]; then
  if [ "${NON_INTERACTIVE}" = "true" ]; then
    INSTALL_CLAMAV=true
  else
    echo ""
    echo -e "${BOLD}Optional: Upload Malware Scanning (ClamAV)${RESET}"
    echo "  This installs ClamAV so uploads can be scanned before storage."
    echo "  If disabled, uploads still work normally but are not malware-scanned."
    read -r -p "Install and enable ClamAV scanning? [Y/n]: " clamav_choice
    case "${clamav_choice:-Y}" in
      y|Y|yes|YES|"")
        INSTALL_CLAMAV=true
        ;;
      n|N|no|NO)
        INSTALL_CLAMAV=false
        ;;
      *)
        warn "Unrecognized choice, defaulting to Yes."
        INSTALL_CLAMAV=true
        ;;
    esac
  fi
fi

ROLLBACK_READY=false
PREV_REF=""
BACKUP_DIR=""
PRE_UPDATE_CONFIG_BACKUP=""
PRE_UPDATE_DB_BACKUP=""

rollback_on_error() {
  local exit_code=$?
  trap - ERR
  set +e

  if [ "${ROLLBACK_READY}" = "true" ]; then
    warn "Install/update failed. Attempting rollback to previous known-good state..."

    if [ -n "${PREV_REF}" ] && [ -d "${APP_DIR}/.git" ]; then
      git -C "$APP_DIR" checkout --quiet "$PREV_REF" >/dev/null 2>&1
      if [ -d "${APP_DIR}" ]; then
        (
          cd "${APP_DIR}" || exit 1
          npm ci --quiet >/dev/null 2>&1
          npm run build --quiet >/dev/null 2>&1
          npm prune --omit=dev --quiet >/dev/null 2>&1
        )
      fi
    fi

    if [ -n "${PRE_UPDATE_CONFIG_BACKUP}" ] && [ -f "${PRE_UPDATE_CONFIG_BACKUP}" ]; then
      cp -f "${PRE_UPDATE_CONFIG_BACKUP}" "${DATA_DIR}/config.json"
    fi
    if [ -n "${PRE_UPDATE_DB_BACKUP}" ] && [ -f "${PRE_UPDATE_DB_BACKUP}" ]; then
      cp -f "${PRE_UPDATE_DB_BACKUP}" "${DATA_DIR}/chitchat.db"
    fi

    if systemctl list-unit-files | grep -q "^${SERVICE_NAME}\\.service"; then
      systemctl daemon-reload >/dev/null 2>&1
      systemctl restart "${SERVICE_NAME}" >/dev/null 2>&1
    fi

    warn "Rollback attempted. Inspect logs with: sudo journalctl -u ${SERVICE_NAME} -n 200 --no-pager"
  fi

  exit "$exit_code"
}

trap rollback_on_error ERR

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
# Optional: install ClamAV for upload malware scanning
if [ "${INSTALL_CLAMAV}" = "true" ]; then
  info "Installing ClamAV (upload malware scanning)..."
  if command -v apt-get &> /dev/null; then
    apt-get update -qq && apt-get install -y -qq clamav clamav-daemon > /dev/null
    CLAMAV_SERVICE="clamav-daemon"
  elif command -v dnf &> /dev/null; then
    dnf install -y -q clamav clamav-update clamd > /dev/null
    if systemctl list-unit-files | grep -q '^clamd@scan\.service'; then
      CLAMAV_SERVICE="clamd@scan"
    else
      CLAMAV_SERVICE="clamd"
    fi
  elif command -v yum &> /dev/null; then
    yum install -y -q clamav clamav-update clamd > /dev/null
    if systemctl list-unit-files | grep -q '^clamd@scan\.service'; then
      CLAMAV_SERVICE="clamd@scan"
    else
      CLAMAV_SERVICE="clamd"
    fi
  else
    warn "Unsupported package manager for ClamAV auto-install. Skipping antivirus setup."
    INSTALL_CLAMAV=false
  fi

  if [ "${INSTALL_CLAMAV}" = "true" ]; then
    if [ -n "${CLAMAV_SERVICE}" ] && systemctl list-unit-files | grep -q "^${CLAMAV_SERVICE}\\.service"; then
      systemctl enable "${CLAMAV_SERVICE}" --quiet || true
      systemctl restart "${CLAMAV_SERVICE}" || true
      sleep 2
      if systemctl is-active --quiet "${CLAMAV_SERVICE}"; then
        CLAMAV_READY=true
        ok "ClamAV service is active (${CLAMAV_SERVICE})"
      else
        warn "ClamAV service is not active (${CLAMAV_SERVICE}). Upload scanning will remain disabled."
      fi
    else
      warn "ClamAV service unit was not found. Upload scanning will remain disabled."
    fi
  fi
else
  warn "Skipping ClamAV installation (--skip-clamav). Upload scanning will remain disabled."
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

  # Read existing API key and secret from the "keys:" section of the YAML
  # Format is:  keys:\n    APIxxx: secret-string
  LK_API_KEY=$(awk '/^keys:/{getline; print; exit}' "$LIVEKIT_CONFIG" | sed -E 's/^\s+(\S+):.*/\1/' || echo "")
  LK_API_SECRET=$(awk '/^keys:/{getline; print; exit}' "$LIVEKIT_CONFIG" | sed -E 's/^\s+\S+:\s*(\S+).*/\1/' || echo "")
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

# Mark the app directory as safe for git (ownership may differ when running as root)
git config --global --add safe.directory "$APP_DIR" 2>/dev/null

if [ -d "${APP_DIR}/.git" ]; then
  # Existing installation - pull updates with rollback checkpoints
  info "Updating existing installation..."
  PREV_REF=$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo "")
  BACKUP_DIR="${DATA_DIR}/backups/install-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_DIR"
  if [ -f "${DATA_DIR}/config.json" ]; then
    PRE_UPDATE_CONFIG_BACKUP="${BACKUP_DIR}/config.json.pre-update"
    cp -f "${DATA_DIR}/config.json" "$PRE_UPDATE_CONFIG_BACKUP"
  fi
  if [ -f "${DATA_DIR}/chitchat.db" ]; then
    PRE_UPDATE_DB_BACKUP="${BACKUP_DIR}/chitchat.db.pre-update"
    cp -f "${DATA_DIR}/chitchat.db" "$PRE_UPDATE_DB_BACKUP"
  fi
  ROLLBACK_READY=true

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
  # Fresh install - clone the repo
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
cd "${APP_DIR}"
npm ci --quiet 2>&1 | tail -1

ok "Dependencies installed"

info "Building server..."
npm run build --quiet 2>&1 | tail -1
ok "Build complete"

# Remove dev dependencies to save space
info "Pruning dev dependencies..."
npm prune --omit=dev --quiet 2>&1 | tail -1
ok "Dev dependencies removed"

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

CONFIG_EXISTED=false
if [ -f "${DATA_DIR}/config.json" ]; then
  CONFIG_EXISTED=true
fi

info "Running database migration preflight..."
sudo -u "$SERVICE_USER" env DATA_DIR="$DATA_DIR" node "${APP_DIR}/dist/index.js" --migrate-only
ok "Database migration preflight complete"

# Check if config already exists (upgrade scenario)
if [ "${CONFIG_EXISTED}" = "true" ]; then
  ok "Existing config found, skipping setup"
else
  if [ "$NON_INTERACTIVE" = "true" ]; then
    [ -n "$SETUP_ADMIN_EMAIL" ] || fail "Missing --admin-email for --non-interactive first install"
    [ -n "$SETUP_ADMIN_USERNAME" ] || fail "Missing --admin-username for --non-interactive first install"
    [ -n "$SETUP_ADMIN_PASSWORD" ] || fail "Missing --admin-password for --non-interactive first install"

    info "Running first-time setup (non-interactive)..."
    setup_args=(
      --setup
      --admin-email "$SETUP_ADMIN_EMAIL"
      --admin-username "$SETUP_ADMIN_USERNAME"
      --admin-password "$SETUP_ADMIN_PASSWORD"
    )
    if [ -n "$SETUP_SERVER_NAME" ]; then
      setup_args+=(--server-name "$SETUP_SERVER_NAME")
    fi

    sudo -u "$SERVICE_USER" env DATA_DIR="$DATA_DIR" node "${APP_DIR}/dist/index.js" "${setup_args[@]}"
  else
    info "Running first-time setup..."
    echo ""

    # Run setup interactively as the chitchat user
    # Note: </dev/tty is required when running via curl|bash so stdin reads from the terminal
    cd "$DATA_DIR"
    sudo -u "$SERVICE_USER" env DATA_DIR="$DATA_DIR" node "${APP_DIR}/dist/index.js" --setup </dev/tty
  fi
fi

# ─── Auto-configure LiveKit in ChitChat config ───────────────────────

info "Configuring LiveKit and upload scanning..."

# Detect the server's primary IP address (the one used for default route)
SERVER_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
if [ -z "$SERVER_IP" ]; then
  SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")
fi
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

  // Configure optional ClamAV upload scanning
  if (!config.files) config.files = {};
  if (!config.files.antivirus) config.files.antivirus = {};
  config.files.antivirus.provider = 'clamav';
  config.files.antivirus.clamavHost = '${CLAMAV_HOST}';
  config.files.antivirus.clamavPort = ${CLAMAV_PORT};
  config.files.antivirus.timeoutMs = ${CLAMAV_TIMEOUT_MS};
  config.files.antivirus.failClosed = ${CLAMAV_FAIL_CLOSED};
  config.files.antivirus.enabled = ${CLAMAV_READY};

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
"

ok "LiveKit configured (${LK_WS_URL})"
if [ "${CLAMAV_READY}" = "true" ]; then
  ok "Upload malware scanning enabled (ClamAV ${CLAMAV_HOST}:${CLAMAV_PORT})"
else
  warn "Upload malware scanning remains disabled (ClamAV not active)"
fi

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
ExecStart=$(command -v node) ${APP_DIR}/dist/index.js
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
Environment=DATA_DIR=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" --quiet
ok "Systemd service installed and enabled"

# ─── Start the service ───────────────────────────────────────────────

info "Starting ChitChat server..."
systemctl start "$SERVICE_NAME"

# Wait a moment and check status + health endpoint
sleep 3
PORT=$(grep '"port"' "${DATA_DIR}/config.json" 2>/dev/null | head -1 | sed -E 's/.*: *([0-9]+).*/\1/' || echo "3001")

if ! systemctl is-active --quiet "$SERVICE_NAME"; then
  fail "Server failed to start. Check: journalctl -u ${SERVICE_NAME} -n 200 --no-pager"
fi

for _ in $(seq 1 "$HEALTH_TIMEOUT_SECONDS"); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    ok "Server is running and passed health check"
    ROLLBACK_READY=false
    break
  fi
  sleep 1
done

if [ "${ROLLBACK_READY}" = "true" ]; then
  fail "Server did not pass health check at http://127.0.0.1:${PORT}/api/health"
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
echo -e "  ${BOLD}If you use HTTPS via Nginx/Cloudflare:${RESET}"
echo -e "  ${DIM}  1) Use your HTTPS domain in clients (not :${PORT})${RESET}"
echo -e "  ${DIM}  2) In Admin > Security, enable 'Trust Reverse Proxy'${RESET}"
echo -e "  ${DIM}  3) In Admin > Media, set LiveKit URL to wss://<your-livekit-domain>${RESET}"
echo -e "  ${DIM}     (Default ws://${SERVER_IP}:${LIVEKIT_PORT} is for direct/local setups)${RESET}"
echo ""
echo -e "  ${DIM}To update later, run this installer again.${RESET}"
echo ""
