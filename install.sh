#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────
# Sophie installer
# Installs dependencies and registers the global `sophie` command.
# ───────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

cyan()  { printf "\033[36m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }

cyan "╭──────────────────────────────────────────╮"
cyan "│            Installing Sophie             │"
cyan "╰──────────────────────────────────────────╯"

# 1. Require Bun (offer to install it) ------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  yellow "• Bun is not installed."
  # Bun's install script needs curl (or wget) and unzip.
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    red "✗ Need curl or wget to install Bun. Install one and re-run ./install.sh"
    exit 1
  fi
  printf "  Install Bun now? [Y/n] "
  read -r reply </dev/tty 2>/dev/null || reply="y"
  case "${reply:-y}" in
    [nN]*)
      red "✗ Bun is required. Install it with:  curl -fsSL https://bun.sh/install | bash"
      exit 1
      ;;
  esac
  cyan "→ Installing Bun..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | bash
  else
    wget -qO- https://bun.sh/install | bash
  fi
  # Make bun available in THIS shell for the rest of the install.
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    red "✗ Bun installed but isn't on PATH yet. Open a new terminal and re-run ./install.sh"
    exit 1
  fi
fi
green "✓ Found bun $(bun --version)"

# 2. Dependencies ---------------------------------------------------------
cyan "→ Installing dependencies..."
bun install

# 3. TTS runtime -----------------------------------------------------------
cyan "→ Checking Sophie TTS runtime..."
TTS_VENV="$SCRIPT_DIR/.tts-venv"
TTS_PY="$TTS_VENV/bin/python"
TTS_MODEL_DIR="${SOPHIE_MODEL_DIR:-$HOME/.local/share/sophie/models}"
TTS_MODEL="${SOPHIE_TTS_MODEL:-$TTS_MODEL_DIR/tts/kokoro-v1.0.onnx}"
TTS_VOICES="${SOPHIE_TTS_VOICES:-$TTS_MODEL_DIR/tts/voices-v1.0.bin}"
TTS_SKIPPED=false

if [[ "${SOPHIE_INSTALL_TTS:-1}" =~ ^(0|false|no|off)$ ]]; then
  TTS_SKIPPED=true
  yellow "• Skipping optional TTS runtime (SOPHIE_INSTALL_TTS=${SOPHIE_INSTALL_TTS})."
elif ! command -v python3 >/dev/null 2>&1; then
  yellow "• python3 is missing; Sophie TTS sidecar cannot be installed yet."
elif [ ! -x "$TTS_PY" ]; then
  cyan "→ Creating Sophie TTS virtualenv..."
  python3 -m venv "$TTS_VENV"
  "$TTS_PY" -m pip install --upgrade pip
  "$TTS_PY" -m pip install kokoro-onnx soundfile 'misaki[en]'
else
  green "✓ Sophie TTS virtualenv already exists."
fi

if [ "$TTS_SKIPPED" = false ] && [ -x "$TTS_PY" ]; then
  green "✓ Sophie TTS Python: $TTS_PY"
fi
if [ "$TTS_SKIPPED" = false ] && [ -f "$TTS_MODEL" ]; then
  green "✓ Kokoro model: $TTS_MODEL"
elif [ "$TTS_SKIPPED" = false ]; then
  yellow "• Kokoro model missing: $TTS_MODEL"
fi
if [ "$TTS_SKIPPED" = false ] && [ -f "$TTS_VOICES" ]; then
  green "✓ Kokoro voices: $TTS_VOICES"
elif [ "$TTS_SKIPPED" = false ]; then
  yellow "• Kokoro voices missing: $TTS_VOICES"
fi
if [ "$TTS_SKIPPED" = false ] && { [ ! -f "$TTS_MODEL" ] || [ ! -f "$TTS_VOICES" ]; }; then
  yellow "  Voice is optional. To enable it, download the two Kokoro files:"
  yellow "    mkdir -p $TTS_MODEL_DIR/tts && cd $TTS_MODEL_DIR/tts"
  yellow "    curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
  yellow "    curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
  yellow "  then set SOPHIE_TTS_AUTOSTART=true in .env (see README: Optional neural voice)."
fi

# 4. .env -----------------------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  yellow "✓ Created .env from template — edit it to point at your local model."
else
  green "✓ .env already exists (left untouched)."
fi

# 5. Make the entry executable & register global command ------------------
chmod +x ./bin/sophie.ts
cyan "→ Registering global 'sophie' command..."

BUN_BIN="$(bun pm bin -g 2>/dev/null || echo "$HOME/.bun/bin")"
mkdir -p "$BUN_BIN"

if bun link >/dev/null 2>&1; then
  green "✓ Registered package with bun link."
else
  yellow "• bun link was unavailable; installing a direct launcher instead."
fi

# Always refresh the launcher so reinstalling from a moved or newly cloned repo
# cannot leave `sophie` pointing at an older checkout.
cat > "$BUN_BIN/sophie.tmp" <<EOF
#!/usr/bin/env bash
exec bun run "$SCRIPT_DIR/bin/sophie.ts" "\$@"
EOF
chmod +x "$BUN_BIN/sophie.tmp"
mv "$BUN_BIN/sophie.tmp" "$BUN_BIN/sophie"

if command -v sophie >/dev/null 2>&1; then
  green "✓ 'sophie' is available on your PATH."
else
  yellow "• '$BUN_BIN' is not on your PATH yet."
fi

green "✓ Installed."
echo
cyan "──────────────────────────────────────────────"
green "Sophie is ready."
echo
echo "Next steps:"
if ! command -v sophie >/dev/null 2>&1; then
  echo "  • Add Bun's bin directory to your PATH:"
  echo "      export PATH=\"$BUN_BIN:\$PATH\""
fi
echo "  • Edit your model settings in:"
echo "      $SCRIPT_DIR/.env"
echo "  • Start your local model server, then verify setup:"
green "      sophie doctor"
echo "  • Launch Sophie:"
green "      sophie"
cyan "──────────────────────────────────────────────"
