#!/usr/bin/env sh
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
node src/index.js
