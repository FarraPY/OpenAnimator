#!/data/data/com.termux/files/usr/bin/bash
# Whisper para OpenAnimator: compila whisper.cpp en Termux (una sola vez) y descarga un modelo.
# Lo lanza la app (Ajustes › Plugins › Whisper) en una sesión visible de Termux; también se puede
# correr a mano:  bash ~/.openanimator/whisper-install.sh small
#
# Sin pipefail a propósito: «yes | pkg …» termina con yes cortado y eso no es un error.
set -eu

TAG=v1.9.4
COMMIT=927cfce34f31707e17f2bff35c349632fb9e2c3a
W="$HOME/.openanimator/whisper"
MODEL="${1:-small}"

# Sumas SHA-1 publicadas por whisper.cpp (models/README.md).
case "$MODEL" in
  base) SHA=465707469ff3a37a2b9b8d8f89f2f99de7299dac ;;
  small) SHA=55356645c2b361a969dfd0ef2c5a50d530afd8d5 ;;
  large-v3-turbo-q5_0) SHA=e050f7970618a659205450ad97eb95a18d69c9ee ;;
  *) echo "Modelo desconocido: $MODEL" >&2; exit 2 ;;
esac

paso() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }
fallo() { printf '\n\033[1;31m%s\033[0m\n' "$1" >&2; exit 1; }
sha() { sha1sum "$1" | cut -d' ' -f1; }

mkdir -p "$W/bin" "$W/models"

if [ -x "$W/bin/whisper-cli" ] && [ "$(cat "$W/VERSION" 2>/dev/null)" = "$TAG" ]; then
  paso "whisper.cpp $TAG ya está instalado"
else
  paso "1/3 · Herramientas para compilar (clang, cmake, git)"
  yes | pkg install clang cmake make git
  paso "2/3 · Compilando whisper.cpp $TAG (tarda unos minutos)"
  SRC="$W/src"
  rm -rf "$SRC"
  git clone --depth 1 --branch "$TAG" https://github.com/ggml-org/whisper.cpp "$SRC"
  [ "$(git -C "$SRC" rev-parse HEAD)" = "$COMMIT" ] || fallo "El código descargado no es el de whisper.cpp $TAG."
  # Estático (el programa no depende de la carpeta de compilación) y sin OpenMP (inestable en Termux).
  # ggml prueba qué instrucciones tiene de verdad el procesador antes de usarlas.
  cmake -S "$SRC" -B "$SRC/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_OPENMP=OFF \
    -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DWHISPER_SDL2=OFF
  cmake --build "$SRC/build" --config Release -j 4 --target whisper-cli
  install -m 755 "$SRC/build/bin/whisper-cli" "$W/bin/whisper-cli"
  # Muestra de voz (dominio público) para medir la velocidad desde la app.
  cp "$SRC/samples/jfk.wav" "$W/jfk.wav"
  echo "$TAG" > "$W/VERSION"
  rm -rf "$SRC"
fi
"$W/bin/whisper-cli" --version >/dev/null 2>&1 || fallo "whisper-cli no arranca. Borrá $W y volvé a instalar."

paso "3/3 · Modelo $MODEL"
F="$W/models/ggml-$MODEL.bin"
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"
if [ -f "$F" ] && [ "$(sha "$F")" = "$SHA" ]; then
  echo "Ya estaba descargado."
else
  rm -f "$F"
  # Una descarga cortada sigue desde donde quedó; si la parte no sirve, se baja de nuevo.
  if ! { [ -f "$F.part" ] && [ "$(sha "$F.part")" = "$SHA" ]; }; then
    curl -fL --retry 3 -C - -o "$F.part" "$URL" || { rm -f "$F.part"; curl -fL --retry 3 -o "$F.part" "$URL"; }
  fi
  [ "$(sha "$F.part")" = "$SHA" ] || { rm -f "$F.part"; fallo "El modelo descargado está dañado: volvé a intentar."; }
  mv "$F.part" "$F"
fi

paso "Listo. Volvé a OpenAnimator y tocá «Probar»."
