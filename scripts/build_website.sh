#!/usr/bin/env bash
# Build the Charted Roots Quartz website from the obsidian vault.
# Run from anywhere — the script resolves the repo root automatically.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VAULT="$ROOT/obsidian"
SITE="$ROOT/website"
CONTENT="$SITE/content"

echo "Syncing content..."
mkdir -p "$CONTENT"
rm -rf "$CONTENT/People" "$CONTENT/attachments" "$CONTENT/Places" "$CONTENT/Families"
rsync -a "$VAULT/People/"       "$CONTENT/People/"
rsync -a "$VAULT/attachments/"  "$CONTENT/attachments/"
rsync -a "$VAULT/Places/"       "$CONTENT/Places/"
rsync -a "$VAULT/Families/"     "$CONTENT/Families/"
cp "$VAULT/Elie-Patan-Family-Website.md" "$CONTENT/"
cp "$VAULT/Yossi-Gal-Family-Website.md" "$CONTENT/"
cp "$VAULT/index.md"                     "$CONTENT/"

echo "Building site..."
rm -rf "$SITE/public"
cd "$SITE" && node quartz/bootstrap-cli.mjs build

echo "Done. Output: $SITE/public"
