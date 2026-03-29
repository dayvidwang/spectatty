#!/bin/bash
set -e

# Install dependencies
bun install

# Verify bun-pty works (native addon)
bun -e "require('bun-pty')" 2>/dev/null || echo "Warning: bun-pty may not be available"
