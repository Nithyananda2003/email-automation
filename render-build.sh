#!/usr/bin/env bash
# exit on error
set -o errexit

npm install
# Install Chrome for Puppeteer
npx puppeteer browsers install chrome
