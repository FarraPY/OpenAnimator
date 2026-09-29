#!/usr/bin/env bash
# Arma OpenAnimator.apk sin Gradle: interfaz web (Vite) → aapt2 → javac → d8/dx → zipalign → apksigner.
#
# Herramientas, en este orden:
#   1. $ANDROID_HOME (Android SDK: build-tools + platforms/android-34 o más nuevo), como en GitHub Actions.
#   2. Paquetes de Debian/Ubuntu (aapt2, dalvik-exchange, zipalign, apksigner) + $ANDROID_JAR
#      (un android.jar de API 34+, p. ej. el android-all de Robolectric).
#
# Variables opcionales: VERSION_NAME, VERSION_CODE, SKIP_WEB=1 (no recompilar la interfaz),
# OA_KEYSTORE / OA_KEYSTORE_PASS / OA_KEY_ALIAS (firma), OUT_APK (ruta del APK final).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
BUILD="$HERE/build"
APP="$HERE/app"
PKG=com.farrapy.openanimator

VERSION_NAME="${VERSION_NAME:-$(node -p "require('$ROOT/package.json').version")}"
# Minutos desde 2025-01-01: siempre crece, así cada APK nuevo se instala encima del anterior.
VERSION_CODE="${VERSION_CODE:-$(( ($(date +%s) - 1735689600) / 60 ))}"
OUT_APK="${OUT_APK:-$BUILD/OpenAnimator-$VERSION_NAME.apk}"

log() { printf '\033[1;35m▸\033[0m %s\n' "$*"; }

# ── herramientas ──────────────────────────────────────────────────────────────
BT=""
if [ -n "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ]; then
  SDK="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
  BT="$(ls -d "$SDK"/build-tools/*/ 2>/dev/null | sort -V | tail -1)"
  if [ -z "${ANDROID_JAR:-}" ]; then
    for p in $(ls -d "$SDK"/platforms/android-*/ 2>/dev/null | sort -V -r); do
      n="$(basename "$p" | sed 's/android-//')"
      if [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -ge 34 ] && [ -f "$p/android.jar" ]; then ANDROID_JAR="$p/android.jar"; break; fi
    done
  fi
fi
tool() { if [ -n "$BT" ] && [ -x "$BT/$1" ]; then echo "$BT/$1"; elif command -v "$1" >/dev/null; then command -v "$1"; else echo ""; fi; }
AAPT2="$(tool aapt2)"; ZIPALIGN="$(tool zipalign)"; APKSIGNER="$(tool apksigner)"; D8="$(tool d8)"
DX=""; [ -z "$D8" ] && DX="$(command -v dalvik-exchange || command -v dx || true)"
for t in AAPT2 ZIPALIGN APKSIGNER; do [ -n "${!t}" ] || { echo "Falta la herramienta ${t,,} (instalá el Android SDK o: apt install aapt zipalign apksigner dalvik-exchange)"; exit 1; }; done
[ -n "$D8$DX" ] || { echo "Falta d8 (build-tools) o dx (dalvik-exchange)"; exit 1; }
[ -f "${ANDROID_JAR:-}" ] || { echo "Falta ANDROID_JAR (android.jar de API 34 o más nuevo)"; exit 1; }
log "android.jar: $ANDROID_JAR"
log "herramientas: $AAPT2 · ${D8:-$DX} · $APKSIGNER"

# ── interfaz web ──────────────────────────────────────────────────────────────
if [ "${SKIP_WEB:-}" != "1" ]; then
  log "Compilando la interfaz (Vite)…"
  (cd "$ROOT" && node android/scripts/build-web.mjs)
fi
[ -f "$BUILD/www/index.html" ] || { echo "No está la interfaz compilada en $BUILD/www (corré sin SKIP_WEB)"; exit 1; }

# ── recursos y manifiesto ─────────────────────────────────────────────────────
rm -rf "$BUILD/apk" && mkdir -p "$BUILD/apk/gen" "$BUILD/apk/classes" "$BUILD/apk/dex" "$BUILD/apk/assets"
cp -r "$BUILD/www" "$BUILD/apk/assets/www"
log "Recursos (aapt2)…"
"$AAPT2" compile --dir "$APP/res" -o "$BUILD/apk/res.zip"
"$AAPT2" link -o "$BUILD/apk/base.apk" -I "$ANDROID_JAR" --manifest "$APP/AndroidManifest.xml" \
  --min-sdk-version 26 --target-sdk-version 34 --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  -A "$BUILD/apk/assets" --java "$BUILD/apk/gen" --auto-add-overlay \
  -0 mp4 -0 mp3 -0 jpg -0 png -0 woff2 \
  "$BUILD/apk/res.zip"

mkdir -p "$BUILD/apk/gen/com/farrapy/openanimator"
cat > "$BUILD/apk/gen/com/farrapy/openanimator/BuildInfo.java" <<EOF
package $PKG;

/** Generado por build-apk.sh. */
final class BuildInfo {
    static final String APPLICATION_ID = "$PKG";
    static final String VERSION_NAME = "$VERSION_NAME";
    static final int VERSION_CODE = $VERSION_CODE;

    private BuildInfo() {
    }
}
EOF

# ── código Java ───────────────────────────────────────────────────────────────
log "Compilando Java…"
if ! javac --release 8 -Xlint:-options -encoding UTF-8 -proc:none -nowarn -classpath "$ANDROID_JAR" -d "$BUILD/apk/classes" \
  $(find "$APP/java" "$BUILD/apk/gen" -name '*.java') > "$BUILD/apk/javac.log" 2>&1; then
  grep -v "JAVA_TOOL_OPTIONS" "$BUILD/apk/javac.log"; echo "Falló la compilación de Java"; exit 1
fi
grep -v "JAVA_TOOL_OPTIONS" "$BUILD/apk/javac.log" || true
[ -f "$BUILD/apk/classes/com/farrapy/openanimator/MainActivity.class" ] || { echo "Falló la compilación de Java"; exit 1; }
log "DEX…"
if [ -n "$D8" ]; then
  "$D8" --release --min-api 26 --lib "$ANDROID_JAR" --output "$BUILD/apk/dex" $(find "$BUILD/apk/classes" -name '*.class')
else
  "$DX" --dex --min-sdk-version=26 --output="$BUILD/apk/dex/classes.dex" "$BUILD/apk/classes" 2>&1 | grep -v "JAVA_TOOL_OPTIONS" || true
fi
[ -f "$BUILD/apk/dex/classes.dex" ] || { echo "Falló la conversión a DEX"; exit 1; }

# ── APK firmado ───────────────────────────────────────────────────────────────
cp "$BUILD/apk/base.apk" "$BUILD/apk/unsigned.apk"
(cd "$BUILD/apk/dex" && zip -q -X "$BUILD/apk/unsigned.apk" classes.dex)
"$ZIPALIGN" -f -p 4 "$BUILD/apk/unsigned.apk" "$BUILD/apk/aligned.apk"
KS="${OA_KEYSTORE:-$HERE/keystore/openanimator.jks}"
log "Firmando con $(basename "$KS")…"
"$APKSIGNER" sign --ks "$KS" --ks-pass "pass:${OA_KEYSTORE_PASS:-openanimator}" --ks-key-alias "${OA_KEY_ALIAS:-openanimator}" \
  --out "$OUT_APK" "$BUILD/apk/aligned.apk" 2>&1 | grep -v "JAVA_TOOL_OPTIONS" || true
"$APKSIGNER" verify "$OUT_APK" 2>&1 | grep -v "JAVA_TOOL_OPTIONS" || true
rm -f "$OUT_APK.idsig"
log "Listo: $OUT_APK ($(du -h "$OUT_APK" | cut -f1)) · versión $VERSION_NAME ($VERSION_CODE)"
