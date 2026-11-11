#!/bin/zsh
# Double-click to start TapVRM in a Terminal window (close the window or Ctrl-C to quit).
cd "$(dirname "$0")"
[[ -x ./tapvrm ]] || ./build.sh
exec ./tapvrm "$@"
