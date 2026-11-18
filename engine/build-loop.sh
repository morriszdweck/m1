#!/usr/bin/env bash
# Builds the engine M1 runs SenseNova Loop 9B with: SenseNova's llama.cpp (stock llama.cpp
# can't load the model yet) plus sensenova-loops.patch, which lets LLAMA_SENSENOVA_LOOPS set
# how many times the shared middle layers run. Writes dist/<name>.tar.gz and its .sha256.
#
#   engine/build-loop.sh metal    # Apple silicon
#   engine/build-loop.sh vulkan   # Linux x64 with a Vulkan driver
#   engine/build-loop.sh cpu      # Linux x64, processor only (CI tests)
set -euo pipefail

FLAVOR="${1:?metal, vulkan or cpu}"
REPO="https://github.com/OpenSenseNova/llama.cpp.git"
COMMIT="24ea7bb78410e0f0f7bbb362e37c60cd9ecfc761" # the commit SenseNova's model card names
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-$HERE/.build}"
OUT="${OUT:-$HERE/dist}"

# Built for every Apple silicon Mac, or any x64 processor since 2013 (AVX2), not just the one
# that builds it (GGML_NATIVE=OFF).
X64=(-DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_BMI2=ON)
case "$FLAVOR" in
  metal) NAME="llama-loop-macos-arm64"; FLAGS=(-DGGML_METAL=ON -DGGML_NATIVE=OFF -DGGML_METAL_EMBED_LIBRARY=ON -DCMAKE_OSX_DEPLOYMENT_TARGET=13.3) ;;
  vulkan) NAME="llama-loop-ubuntu-vulkan-x64"; FLAGS=(-DGGML_VULKAN=ON "${X64[@]}") ;;
  cpu) NAME="llama-loop-ubuntu-x64"; FLAGS=("${X64[@]}") ;;
  *) echo "Unknown flavor $FLAVOR" >&2; exit 1 ;;
esac

rm -rf "${WORK:?}"
git init -q "$WORK"
git -C "$WORK" remote add origin "$REPO"
git -C "$WORK" fetch -q --depth 1 origin "$COMMIT"
git -C "$WORK" checkout -q FETCH_HEAD
git -C "$WORK" apply "$HERE/sensenova-loops.patch"

# One self-contained llama-server: no shared libraries, no built-in web page, no curl or
# OpenSSL (M1 only talks to it over 127.0.0.1, and a Homebrew OpenSSL wouldn't be on other Macs).
cmake -S "$WORK" -B "$WORK/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
  "${FLAGS[@]}"
cmake --build "$WORK/build" --target llama-server -j "$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

rm -rf "${OUT:?}/${NAME:?}"
mkdir -p "$OUT/$NAME"
cp "$WORK/build/bin/llama-server" "$OUT/$NAME/"
cp "$WORK/LICENSE" "$OUT/$NAME/LICENSE-llama.cpp"
cp "$HERE/sensenova-loops.patch" "$OUT/$NAME/"
"$OUT/$NAME/llama-server" --version
# Only system libraries, so it runs on a computer that has nothing extra installed.
if [ "$(uname)" = Darwin ]; then LIBS="$(otool -L "$OUT/$NAME/llama-server" | tail -n +2)"; else LIBS="$(ldd "$OUT/$NAME/llama-server")"; fi
echo "$LIBS"
if echo "$LIBS" | grep -E "/opt/homebrew|/usr/local|not found"; then echo "llama-server needs a library other computers won't have" >&2; exit 1; fi
tar -C "$OUT" -czf "$OUT/$NAME.tar.gz" "$NAME"
(cd "$OUT" && { shasum -a 256 "$NAME.tar.gz" 2>/dev/null || sha256sum "$NAME.tar.gz"; } > "$NAME.tar.gz.sha256")
cat "$OUT/$NAME.tar.gz.sha256"
