#!/usr/bin/env bash
set -euo pipefail

# ─── ChitChat Server — Docker Setup ──────────────────────────────────
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Sciphr/chitchat-server/main/docker-setup.sh | sudo bash
#
# Or with a specific version:
#   curl -fsSL https://raw.githubusercontent.com/Sciphr/chitchat-server/main/docker-setup.sh | sudo bash -s -- v1.0.0
#
# Non-interactive / automated:
#   curl -fsSL https://raw.githubusercontent.com/Sciphr/chitchat-server/main/docker-setup.sh | sudo bash -s -- \
#     --non-interactive --admin-email admin@example.com --admin-username admin --admin-password 'changeme'
# ─────────────────────────────────────────────────────────────────────

REPO="Sciphr/chitchat-server"
APP_DIR="/opt/chitchat-server"
LIVEKIT_PORT=7880
LIVEKIT_UDP_PORT_START=50000
LIVEKIT_UDP_PORT_END=50100
HEALTH_TIMEOUT_SECONDS=45

CLAMAV_HOST="clamav"
CLAMAV_PORT=3310
CLAMAV_FAIL_CLOSED=true
CLAMAV_TIMEOUT_MS=15000

BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[32m"
CYAN="\033[36m"
RED="\033[31m"
YELLOW="\033[33m"
RESET="\033[0m"

info()  { echo -e "${CYAN}  ▸${RESET} $1"; }
ok()    { echo -e "${GREEN}  ✓${RESET} $1"; }
warn()  { echo -e "${YELLOW}  !${RESET} $1"; }
fail()  { echo -e "${RED}  ✗${RESET} $1"; exit 1; }

usage() {
  cat <<'USAGE'
Usage:
  sudo bash docker-setup.sh [version] [options]

Options:
  --non-interactive            Run without prompts (requires --admin-email/username/password)
  --admin-email <email>        Admin email for first-time setup
  --admin-username <username>  Admin username for first-time setup
  --admin-password <password>  Admin password for first-time setup
  --server-name <name>         Server display name for first-time setup
  --docker-port <port>         Host port to expose ChitChat on (default: 3001)
  --with-clamav                Enable ClamAV malware scanning (default when non-interactive)
  --skip-clamav                Disable ClamAV malware scanning
  --help                       Show this help
USAGE
}

# Generate a random alphanumeric string of given length
random_string() {
  local len="${1:-32}"
  head -c 256 /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c "$len"
}

# Set or update a KEY=VALUE line in a file
ensure_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"
  if grep -Eq "^${key}=" "$file"; then
    sed -i -E "s|^${key}=.*|${key}=${value}|" "$file"
  else
    echo "${key}=${value}" >> "$file"
  fi
}

ensure_docker_runtime() {
  if command -v docker >/dev/null 2>&1; then
    ok "Docker already installed ($(docker --version | head -1))"
  else
    info "Installing Docker..."
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq
      apt-get install -y -qq docker.io docker-compose-plugin > /dev/null
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y -q docker docker-compose-plugin > /dev/null || dnf install -y -q docker docker-compose > /dev/null
    elif command -v yum >/dev/null 2>&1; then
      yum install -y -q docker docker-compose-plugin > /dev/null || yum install -y -q docker docker-compose > /dev/null
    else
      fail "Unsupported package manager. Install Docker manually, then rerun."
    fi
    ok "Docker installed"
  fi

  if systemctl list-unit-files 2>/dev/null | grep -q '^docker\.service'; then
    systemctl enable docker --quiet 2>/dev/null || true
    systemctl start docker 2>/dev/null || true
  fi

  if ! docker info >/dev/null 2>&1; then
    fail "Docker daemon is not available. Start Docker and rerun."
  fi

  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD=(docker-compose)
  else
    fail "Docker Compose not found. Install the Docker Compose plugin and rerun."
  fi
}

# ─── Argument parsing ────────────────────────────────────────────────

VERSION="latest"
NON_INTERACTIVE=false
SETUP_ADMIN_EMAIL=""
SETUP_ADMIN_USERNAME=""
SETUP_ADMIN_PASSWORD=""
SETUP_SERVER_NAME=""
DOCKER_HOST_PORT=3001
INSTALL_CLAMAV=true
CLAMAV_DECISION_EXPLICIT=false
_skip_port_prompt=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h)
      usage; exit 0 ;;
    --non-interactive)
      NON_INTERACTIVE=true; shift ;;
    --admin-email)
      [ $# -ge 2 ] || fail "--admin-email requires a value"
      SETUP_ADMIN_EMAIL="$2"; shift 2 ;;
    --admin-username)
      [ $# -ge 2 ] || fail "--admin-username requires a value"
      SETUP_ADMIN_USERNAME="$2"; shift 2 ;;
    --admin-password)
      [ $# -ge 2 ] || fail "--admin-password requires a value"
      SETUP_ADMIN_PASSWORD="$2"; shift 2 ;;
    --server-name)
      [ $# -ge 2 ] || fail "--server-name requires a value"
      SETUP_SERVER_NAME="$2"; shift 2 ;;
    --docker-port)
      [ $# -ge 2 ] || fail "--docker-port requires a value"
      [[ "$2" =~ ^[0-9]+$ ]] || fail "--docker-port must be numeric"
      [ "$2" -ge 1 ] && [ "$2" -le 65535 ] || fail "--docker-port must be between 1 and 65535"
      DOCKER_HOST_PORT="$2"; shift 2 ;;
    --with-clamav)
      INSTALL_CLAMAV=true; CLAMAV_DECISION_EXPLICIT=true; shift ;;
    --skip-clamav)
      INSTALL_CLAMAV=false; CLAMAV_DECISION_EXPLICIT=true; shift ;;
    -*)
      fail "Unknown option: $1" ;;
    *)
      if [ "$VERSION" = "latest" ]; then
        VERSION="$1"
      else
        fail "Unexpected argument: $1"
      fi
      shift ;;
  esac
done

# ─── Pre-flight checks ───────────────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
  fail "This script must be run as root. Try: sudo bash docker-setup.sh"
fi

if [ "$(uname -s)" != "Linux" ]; then
  fail "This script only supports Linux. Got: $(uname -s)"
fi

for cmd in curl git; do
  if ! command -v "$cmd" &>/dev/null; then
    info "Installing ${cmd}..."
    if command -v apt-get &>/dev/null; then
      apt-get update -qq && apt-get install -y -qq "$cmd" > /dev/null
    elif command -v yum &>/dev/null; then
      yum install -y -q "$cmd" > /dev/null
    elif command -v dnf &>/dev/null; then
      dnf install -y -q "$cmd" > /dev/null
    else
      fail "Could not install ${cmd}. Please install it manually."
    fi
  fi
done

# ─── Read existing settings from .env (preserves values on update) ───

if [ -f "${APP_DIR}/.env" ]; then
  _existing_host_port="$(grep '^HOST_PORT=' "${APP_DIR}/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
  if [ -n "${_existing_host_port}" ]; then
    DOCKER_HOST_PORT="${_existing_host_port}"
    _skip_port_prompt=true
  fi

  _existing_clamav="$(grep '^FILES_AV_ENABLED=' "${APP_DIR}/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
  if [ -n "${_existing_clamav}" ]; then
    [ "${_existing_clamav}" = "true" ] && INSTALL_CLAMAV=true || INSTALL_CLAMAV=false
    CLAMAV_DECISION_EXPLICIT=true
  fi
fi

# ─── Interactive prompts ─────────────────────────────────────────────

if [ "${_skip_port_prompt}" != "true" ] && [ "${NON_INTERACTIVE}" != "true" ] && [ -r /dev/tty ]; then
  echo ""
  read -r -p "  Host port for ChitChat [${DOCKER_HOST_PORT}]: " docker_port_input </dev/tty || docker_port_input=""
  if [ -n "${docker_port_input}" ]; then
    if [[ "${docker_port_input}" =~ ^[0-9]+$ ]] && [ "${docker_port_input}" -ge 1 ] && [ "${docker_port_input}" -le 65535 ]; then
      DOCKER_HOST_PORT="${docker_port_input}"
    else
      warn "Invalid port, keeping default ${DOCKER_HOST_PORT}."
    fi
  fi
fi

if [ "${CLAMAV_DECISION_EXPLICIT}" != "true" ]; then
  if [ "${NON_INTERACTIVE}" = "true" ]; then
    INSTALL_CLAMAV=true
  elif [ -r /dev/tty ]; then
    echo ""
    echo -e "${BOLD}  Optional: Upload Malware Scanning (ClamAV)${RESET}"
    echo "  Enables the ClamAV Docker service to scan uploaded files for malware."
    echo "  If disabled, uploads still work normally but are not malware-scanned."
    read -r -p "  Enable ClamAV scanning? [Y/n]: " clamav_choice </dev/tty || clamav_choice=""
    case "${clamav_choice:-Y}" in
      y|Y|yes|YES|"") INSTALL_CLAMAV=true ;;
      n|N|no|NO) INSTALL_CLAMAV=false ;;
      *) warn "Unrecognized choice, defaulting to Yes."; INSTALL_CLAMAV=true ;;
    esac
  fi
fi

# ─── Docker runtime ──────────────────────────────────────────────────

ensure_docker_runtime

# ─── Version resolution ──────────────────────────────────────────────

if [ "$VERSION" = "latest" ]; then
  info "Fetching latest release..."
  VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
    | grep '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' || echo "")
  if [ -z "$VERSION" ]; then
    VERSION="main"
    info "No releases found, using main branch"
  fi
fi
ok "Version: ${VERSION}"

# ─── Clone or update repo ────────────────────────────────────────────

git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true

if [ -d "${APP_DIR}/.git" ]; then
  info "Updating existing installation..."
  cd "$APP_DIR"
  if [ "$VERSION" = "main" ]; then
    git fetch --depth=1 origin main --quiet
    git checkout main --quiet
    git reset --hard origin/main --quiet
  else
    git fetch --depth=1 origin "refs/tags/${VERSION}:refs/tags/${VERSION}" --quiet
    git checkout "$VERSION" --quiet
  fi
  ok "Updated to ${VERSION}"
else
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

cd "${APP_DIR}"
[ -f "${APP_DIR}/docker-compose.yml" ] || fail "docker-compose.yml not found in ${APP_DIR}"

# ─── .env setup ──────────────────────────────────────────────────────

if [ ! -f "${APP_DIR}/.env" ]; then
  cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
  ok "Created ${APP_DIR}/.env from .env.example"
else
  ok "Using existing ${APP_DIR}/.env"
fi

# ─── Server IP detection ─────────────────────────────────────────────

SERVER_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
if [ -z "$SERVER_IP" ]; then
  SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")
fi

# ─── LiveKit config ──────────────────────────────────────────────────

DOCKER_LIVEKIT_DIR="${APP_DIR}/deploy/livekit"
DOCKER_LIVEKIT_CONFIG="${DOCKER_LIVEKIT_DIR}/livekit.yaml"
mkdir -p "${DOCKER_LIVEKIT_DIR}"

LK_API_KEY="$(grep -E '^LIVEKIT_API_KEY=' "${APP_DIR}/.env" | tail -1 | cut -d= -f2- || true)"
LK_API_SECRET="$(grep -E '^LIVEKIT_API_SECRET=' "${APP_DIR}/.env" | tail -1 | cut -d= -f2- || true)"
if [ -z "${LK_API_KEY}" ] || [ -z "${LK_API_SECRET}" ]; then
  LK_API_KEY="API$(random_string 12)"
  LK_API_SECRET="$(random_string 36)"
fi

cat > "${DOCKER_LIVEKIT_CONFIG}" << EOF
port: ${LIVEKIT_PORT}
rtc:
  port_range_start: ${LIVEKIT_UDP_PORT_START}
  port_range_end: ${LIVEKIT_UDP_PORT_END}
  use_external_ip: true
keys:
  ${LK_API_KEY}: ${LK_API_SECRET}
logging:
  level: info
EOF
ok "LiveKit config written"

# ─── Write .env variables ────────────────────────────────────────────

ensure_env_var "${APP_DIR}/.env" "PORT" "3001"
ensure_env_var "${APP_DIR}/.env" "HOST_PORT" "${DOCKER_HOST_PORT}"
ensure_env_var "${APP_DIR}/.env" "DB_PATH" "/app/data/chitchat.db"
ensure_env_var "${APP_DIR}/.env" "DATA_DIR" "/app/data"
ensure_env_var "${APP_DIR}/.env" "LIVEKIT_PORT" "${LIVEKIT_PORT}"
ensure_env_var "${APP_DIR}/.env" "LIVEKIT_UDP_PORT_START" "${LIVEKIT_UDP_PORT_START}"
ensure_env_var "${APP_DIR}/.env" "LIVEKIT_UDP_PORT_END" "${LIVEKIT_UDP_PORT_END}"
ensure_env_var "${APP_DIR}/.env" "LIVEKIT_URL" "ws://${SERVER_IP}:${LIVEKIT_PORT}"
ensure_env_var "${APP_DIR}/.env" "LIVEKIT_API_KEY" "${LK_API_KEY}"
ensure_env_var "${APP_DIR}/.env" "LIVEKIT_API_SECRET" "${LK_API_SECRET}"
ensure_env_var "${APP_DIR}/.env" "FILES_AV_PROVIDER" "clamav"
ensure_env_var "${APP_DIR}/.env" "FILES_AV_CLAMAV_HOST" "${CLAMAV_HOST}"
ensure_env_var "${APP_DIR}/.env" "FILES_AV_CLAMAV_PORT" "${CLAMAV_PORT}"
ensure_env_var "${APP_DIR}/.env" "FILES_AV_TIMEOUT_MS" "${CLAMAV_TIMEOUT_MS}"
ensure_env_var "${APP_DIR}/.env" "FILES_AV_FAIL_CLOSED" "${CLAMAV_FAIL_CLOSED}"
if [ "${INSTALL_CLAMAV}" = "true" ]; then
  ensure_env_var "${APP_DIR}/.env" "FILES_AV_ENABLED" "true"
else
  ensure_env_var "${APP_DIR}/.env" "FILES_AV_ENABLED" "false"
fi

# CORS_ALLOWED_ORIGINS is left as-is from .env.example (* by default).
# Users locking down to HTTPS should update it in .env after configuring their domain.

ok "Configuration written to ${APP_DIR}/.env"

# ─── Build image ─────────────────────────────────────────────────────

info "Building Docker image (this may take a minute)..."
"${COMPOSE_CMD[@]}" build chitchat >/dev/null
ok "Docker image built"

# ─── Database migration preflight ────────────────────────────────────

info "Running database migration preflight..."
"${COMPOSE_CMD[@]}" run --rm --no-deps chitchat node dist/index.js --migrate-only >/dev/null
ok "Database migration complete"

# ─── First-time admin setup ──────────────────────────────────────────

if "${COMPOSE_CMD[@]}" run --rm --no-deps chitchat node -e "
  try {
    const c = JSON.parse(require('fs').readFileSync('/app/data/config.json','utf8'));
    process.exit((c.adminEmails && c.adminEmails.length > 0) ? 0 : 1);
  } catch(e) { process.exit(1); }
" >/dev/null 2>&1; then
  ok "Existing config found, skipping first-time setup"
else
  if [ "${NON_INTERACTIVE}" = "true" ]; then
    [ -n "$SETUP_ADMIN_EMAIL" ]    || fail "Missing --admin-email for non-interactive first install"
    [ -n "$SETUP_ADMIN_USERNAME" ] || fail "Missing --admin-username for non-interactive first install"
    [ -n "$SETUP_ADMIN_PASSWORD" ] || fail "Missing --admin-password for non-interactive first install"

    info "Running first-time setup (non-interactive)..."
    setup_args=(--setup --admin-email "$SETUP_ADMIN_EMAIL" --admin-username "$SETUP_ADMIN_USERNAME" --admin-password "$SETUP_ADMIN_PASSWORD")
    [ -n "$SETUP_SERVER_NAME" ] && setup_args+=(--server-name "$SETUP_SERVER_NAME")
    "${COMPOSE_CMD[@]}" run --rm --no-deps chitchat node dist/index.js "${setup_args[@]}"
  else
    info "Running first-time setup..."
    "${COMPOSE_CMD[@]}" run --rm --no-deps chitchat node dist/index.js --setup </dev/tty
  fi
fi

# ─── Start services ──────────────────────────────────────────────────

info "Starting services..."
if [ "${INSTALL_CLAMAV}" = "true" ]; then
  "${COMPOSE_CMD[@]}" --profile clamav up -d --build
else
  "${COMPOSE_CMD[@]}" up -d --build
fi

# ─── Health check ────────────────────────────────────────────────────

info "Waiting for server to be ready..."
for _ in $(seq 1 "$HEALTH_TIMEOUT_SECONDS"); do
  if curl -fsS "http://127.0.0.1:${DOCKER_HOST_PORT}/api/health" >/dev/null 2>&1; then
    ok "Server is running and passed health check"
    break
  fi
  sleep 1
done

if ! curl -fsS "http://127.0.0.1:${DOCKER_HOST_PORT}/api/health" >/dev/null 2>&1; then
  fail "Server did not respond at http://127.0.0.1:${DOCKER_HOST_PORT}/api/health — check logs with: ${COMPOSE_CMD[*]} -f ${APP_DIR} logs chitchat"
fi

# ─── Done ────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}${BOLD}  Docker setup complete!${RESET}"
echo ""
echo -e "  ${BOLD}Your server is running at:${RESET}"
echo -e "  ${CYAN}http://${SERVER_IP}:${DOCKER_HOST_PORT}${RESET}"
echo -e "  ${BOLD}Admin panel:${RESET}"
echo -e "  ${CYAN}http://${SERVER_IP}:${DOCKER_HOST_PORT}/admin${RESET}"
echo -e "  ${BOLD}LiveKit (voice/video):${RESET}"
echo -e "  ${CYAN}ws://${SERVER_IP}:${LIVEKIT_PORT}${RESET}"
echo ""
echo -e "  ${DIM}Useful commands:${RESET}"
echo -e "  ${DIM}  Status:   cd ${APP_DIR} && ${COMPOSE_CMD[*]} ps${RESET}"
echo -e "  ${DIM}  Logs:     cd ${APP_DIR} && ${COMPOSE_CMD[*]} logs -f chitchat${RESET}"
echo -e "  ${DIM}  Restart:  cd ${APP_DIR} && ${COMPOSE_CMD[*]} restart chitchat${RESET}"
echo -e "  ${DIM}  Stop:     cd ${APP_DIR} && ${COMPOSE_CMD[*]} down${RESET}"
echo -e "  ${DIM}  Update:   curl -fsSL https://raw.githubusercontent.com/${REPO}/main/docker-setup.sh | sudo bash${RESET}"
echo -e "  ${DIM}  Config:   ${APP_DIR}/.env${RESET}"
echo ""
