#!/usr/bin/env sh
cd "$(dirname "$0")"
npm install --no-audit --no-fund
node src/index.js
