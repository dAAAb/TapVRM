#!/bin/zsh
# Build TapVRM: web bundle → Go binary → dist/TapVRM.app (+ dist/TapVRM.dmg with "./build.sh dmg")
set -euo pipefail
cd "$(dirname "$0")"
if [[ -x .toolchain/go/bin/go ]]; then export PATH="$PWD/.toolchain/go/bin:$PATH"; fi
export GOTOOLCHAIN=local
[[ -d node_modules ]] || npm install --silent
npm run build --silent
go build -trimpath -ldflags "-s -w" -o tapvrm .

APP=dist/TapVRM.app
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp tapvrm "$APP/Contents/MacOS/TapVRM"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>TapVRM</string>
  <key>CFBundleDisplayName</key><string>TapVRM</string>
  <key>CFBundleIdentifier</key><string>tw.dab.tapvrm</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleExecutable</key><string>TapVRM</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST
if [[ -f assets/AppIcon.icns ]]; then cp assets/AppIcon.icns "$APP/Contents/Resources/"; fi
codesign --force --sign - "$APP" >/dev/null 2>&1 || true   # ad-hoc signature for this Mac
echo "built $APP"

if [[ "${1:-}" == "dmg" ]]; then
  STAGE=$(mktemp -d); cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
  rm -f dist/TapVRM.dmg
  hdiutil create -quiet -volname TapVRM -srcfolder "$STAGE" -ov -format UDZO dist/TapVRM.dmg
  rm -rf "$STAGE"; echo "built dist/TapVRM.dmg"
fi
