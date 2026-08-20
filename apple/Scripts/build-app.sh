#!/bin/bash
#
# Assembles Darkroom.app from the SwiftPM build.
#
# SwiftPM builds executables, not application bundles, and a bare executable
# gets no menu bar, no Dock icon and no window activation. Until there is an
# Xcode project — which is needed anyway for signing, entitlements and
# extensions — this puts the pieces in the shape macOS expects.
#
# Usage: Scripts/build-app.sh [debug|release]

set -euo pipefail

CONFIGURATION="${1:-debug}"
PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PACKAGE_DIR"

echo "Building darkroom-app ($CONFIGURATION)…"
swift build -c "$CONFIGURATION" --product darkroom-app

BIN_PATH="$(swift build -c "$CONFIGURATION" --show-bin-path)"
APP="$PACKAGE_DIR/build/Darkroom.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$BIN_PATH/darkroom-app" "$APP/Contents/MacOS/Darkroom"

# The Metal libraries and any other bundled resources travel in a .bundle
# alongside the executable, and must come with it.
for RESOURCE in "$BIN_PATH"/*.bundle; do
    [ -e "$RESOURCE" ] && cp -R "$RESOURCE" "$APP/Contents/Resources/"
done

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>Darkroom</string>
    <key>CFBundleIdentifier</key><string>design.ysr.darkroom</string>
    <key>CFBundleName</key><string>Darkroom</string>
    <key>CFBundleDisplayName</key><string>Darkroom</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.1</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSHumanReadableCopyright</key><string>Coloristic Darkroom</string>

    <!-- Declares what the app can open, so the Finder offers it in Open With
         and so drag-and-drop from other applications is accepted. -->
    <key>CFBundleDocumentTypes</key>
    <array>
        <dict>
            <key>CFBundleTypeName</key><string>Image</string>
            <key>CFBundleTypeRole</key><string>Editor</string>
            <key>LSHandlerRank</key><string>Alternate</string>
            <key>LSItemContentTypes</key>
            <array>
                <string>public.image</string>
                <string>public.camera-raw-image</string>
            </array>
        </dict>
    </array>
</dict>
</plist>
PLIST

# Ad-hoc signature. Not for distribution — that needs a Developer ID — but
# without any signature at all macOS refuses to run a locally built bundle.
codesign --force --deep --sign - "$APP" 2>/dev/null || {
    echo "  (could not sign; the app may need to be opened via right-click → Open)"
}

echo "Built $APP"
echo
echo "Run it with:  open '$APP'"
