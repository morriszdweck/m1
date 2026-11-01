#!/bin/bash
# Installs M1, or updates it. Run:
#
#   curl -fsSL https://raw.githubusercontent.com/morriszdweck/m1/main/install.sh | bash
#
# Works on macOS and on Linux (x86_64 or arm64). The app goes in ~/.m1,
# with its own copy of Node.js if this computer has none new enough. It comes
# ready to run (no npm or build step) and keeps itself up to date after this.
# It adds "M1" to the app menu (Linux; on macOS the Mac app opens it) and a
# `m1` command, then opens the setup screen. Models
# are downloaded from there.
set -euo pipefail

REPO="${M1_REPO:-morriszdweck/m1}"
BRANCH="${M1_BRANCH:-main}"
ROOT="${M1_HOME:-$HOME/.m1}"
NODE_VERSION="22.11.0"
PORT="${M1_PORT:-8270}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\033[36m→\033[0m %s\n' "$*"; }
fail() {
  printf '\033[31m%s\033[0m\n' "$*" >&2
  exit 1
}

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin)
    DATA="$HOME/Library/Application Support/M1"
    node_os="darwin"
    [ "$ARCH" = "arm64" ] || bold "Heads up: M1 is built for Apple silicon. It will be slow on this Mac."
    ;;
  Linux)
    DATA="${XDG_DATA_HOME:-$HOME/.local/share}/m1"
    node_os="linux"
    case "$ARCH" in
      x86_64 | aarch64 | arm64) ;;
      *) fail "M1 runs on 64-bit Intel, AMD or ARM computers. This one is $ARCH." ;;
    esac
    ;;
  *) fail "M1 runs on macOS and Linux." ;;
esac
command -v curl >/dev/null || fail "curl is missing."
command -v tar >/dev/null || fail "tar is missing."
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{ print $1 }'; }

bold "Installing M1"
mkdir -p "$ROOT/bin" "$DATA/logs"

# ---- Node.js: use one that is new enough, or keep a private copy ----

find_node() {
  for candidate in "$ROOT/node/bin/node" "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    major="$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$major" -ge 22 ]; then
      echo "$candidate"
      return
    fi
  done
}

NODE="$(find_node)"
if [ -z "$NODE" ]; then
  node_arch="arm64"
  [ "$ARCH" = "x86_64" ] && node_arch="x64"
  file="node-v$NODE_VERSION-$node_os-$node_arch.tar.gz"
  step "Getting Node.js $NODE_VERSION"
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$file" -o "$tmp/$file"
  expected="$(curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | awk -v f="$file" '$2 == f { print $1 }')"
  actual="$(sha256 "$tmp/$file")"
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "The Node.js download didn't match its checksum. Try again."
  rm -rf "$ROOT/node"
  mkdir -p "$ROOT/node"
  tar -xzf "$tmp/$file" -C "$ROOT/node" --strip-components 1
  rm -rf "$tmp"
  NODE="$ROOT/node/bin/node"
fi
export PATH="$(dirname "$NODE"):$PATH"
step "Using Node.js $("$NODE" -v)"

# ---- The app ----

# Stop a running copy first so its files can be replaced.
if curl -fs --max-time 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null | grep -q m1; then
  step "Stopping the running M1"
  pkill -f "$ROOT/app/server/index.js" 2>/dev/null || true
  sleep 2
fi

step "Downloading the app"
tmp="$(mktemp -d)"
if [ -n "${M1_BUNDLE:-}" ]; then
  cp "$M1_BUNDLE" "$tmp/app.tar.gz" # a local bundle, for testing
else
  # Every push to main publishes a ready-to-run bundle, so nothing is built here.
  curl -fsSL "https://github.com/$REPO/releases/latest/download/latest.json" -o "$tmp/latest.json" ||
    fail "Couldn't reach GitHub to download M1. Check your connection and try again."
  url="$("$NODE" -p 'require(process.argv[1]).url' "$tmp/latest.json")"
  expected="$("$NODE" -p 'require(process.argv[1]).sha256' "$tmp/latest.json")"
  curl -fsSL "$url" -o "$tmp/app.tar.gz" || fail "The download didn't finish. Try again."
  [ "$(sha256 "$tmp/app.tar.gz")" = "$expected" ] || fail "The download didn't match its checksum. Try again."
fi
tar -xzf "$tmp/app.tar.gz" -C "$tmp"
[ -f "$tmp/m1/server/index.js" ] && [ -f "$tmp/m1/build.json" ] || fail "That download doesn't look like M1."
rm -rf "$ROOT/app.old" "$ROOT/app.next" "$ROOT/app.download" "$ROOT/app.bad"
[ -d "$ROOT/app" ] && mv "$ROOT/app" "$ROOT/app.old"
mv "$tmp/m1" "$ROOT/app"
rm -rf "$tmp" "$ROOT/app.old"

# ---- Ways to open it ----

cat >"$ROOT/bin/m1" <<EOF
#!/bin/bash
# Opens M1, starting it in the background if needed.
#   m1          open it
#   m1 stop     stop it and its models
#   m1 update   get the newest version now (it also updates by itself)
#   m1 logs     show what it printed
ROOT="$ROOT"
DATA="$DATA"
PORT="$PORT"
export PATH="$(dirname "$NODE"):\$PATH"
running() { curl -fs --max-time 2 "http://127.0.0.1:\$PORT/healthz" 2>/dev/null | grep -q m1; }
show() {
  if [ "\$(uname -s)" = Darwin ]; then
    open "\$1"
  elif [ -n "\${DISPLAY:-}\${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null; then
    (xdg-open "\$1" >/dev/null 2>&1 &)
  else
    echo "Open \$1 in your browser." # no desktop here, e.g. over SSH
  fi
}
case "\${1:-open}" in
  open)
    if [ "\$(uname -s)" = Darwin ] && [ -x "/Applications/M1.app/Contents/MacOS/M1" ]; then
      open -a "/Applications/M1.app" # it starts M1 if needed
    elif running; then
      show "http://127.0.0.1:\$PORT"
    else
      echo "Starting M1 at http://127.0.0.1:\$PORT"
      mkdir -p "\$DATA/logs"
      nohup "$NODE" "\$ROOT/app/server/index.js" --open </dev/null >>"\$DATA/logs/server.log" 2>&1 &
    fi
    ;;
  stop) pkill -f "\$ROOT/app/server/index.js" && echo "Stopped." || echo "It wasn't running." ;;
  update) curl -fsSL "https://raw.githubusercontent.com/$REPO/$BRANCH/install.sh" | bash ;;
  logs) tail -n 80 "\$DATA/logs/server.log" ;;
  *) echo "Use: m1 [open|stop|update|logs]" ;;
esac
EOF
chmod +x "$ROOT/bin/m1"

mkdir -p "$HOME/.local/bin"
ln -sf "$ROOT/bin/m1" "$HOME/.local/bin/m1"

if [ "$OS" = "Darwin" ]; then
  # The M1 Mac app (a DMG on the website) is the way to open it on a Mac.
  # Older installs made a small app in ~/Applications that only opened a browser tab: remove it.
  old="$HOME/Applications/M1.app"
  if [ -d "$old" ] && [ ! -e "$old/Contents/MacOS/M1" ]; then rm -rf "$old"; fi
  if [ -e "/Applications/M1.app/Contents/MacOS/M1" ]; then WHERE="Applications or Spotlight"
  else WHERE="the Mac app (get it at m1.mincoffical.codes)"; fi
else
  # An entry in the app menu.
  APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$APPS"
  cat >"$APPS/m1.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=M1
Comment=A private AI agent that runs on this computer
Exec="$ROOT/bin/m1"
Icon=$ROOT/app/web/dist/icon.svg
Terminal=false
Categories=Utility;
EOF
  if command -v update-desktop-database >/dev/null; then update-desktop-database "$APPS" >/dev/null 2>&1 || true; fi
  WHERE="your app menu"
fi

bold "M1 is installed."
echo "Open \"M1\" any time from $WHERE, or run: m1"
if [ "$OS" = "Linux" ]; then
  # Everything works without these; they add the clipboard, audio files and reminder pop-ups.
  if command -v apt-get >/dev/null; then pm="sudo apt install" ffmpeg="ffmpeg" notify="libnotify-bin"
  elif command -v dnf >/dev/null; then pm="sudo dnf install" ffmpeg="ffmpeg-free" notify="libnotify"
  elif command -v pacman >/dev/null; then pm="sudo pacman -S" ffmpeg="ffmpeg" notify="libnotify"
  elif command -v zypper >/dev/null; then pm="sudo zypper install" ffmpeg="ffmpeg" notify="libnotify-tools"
  else pm="" ffmpeg="ffmpeg" notify="notify-send"
  fi
  want=""
  if [ -n "${WAYLAND_DISPLAY:-}" ]; then
    command -v wl-copy >/dev/null || want="$want wl-clipboard"
  else
    command -v xclip >/dev/null || command -v xsel >/dev/null || want="$want xclip"
  fi
  command -v ffmpeg >/dev/null || want="$want $ffmpeg"
  command -v notify-send >/dev/null || want="$want $notify"
  if [ -n "$want" ]; then
    if [ -n "$pm" ]; then echo "Optional extras for the clipboard, audio files and reminders: $pm$want"
    else echo "Optional extras for the clipboard, audio files and reminders:$want"; fi
  fi
fi
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "(To use the m1 command, add ~/.local/bin to your PATH.)" ;;
esac

# The Mac app runs this installer itself and opens M1 when it's done.
if [ -z "${M1_NO_OPEN:-}" ]; then
  step "Opening the setup screen"
  "$ROOT/bin/m1" open
fi
