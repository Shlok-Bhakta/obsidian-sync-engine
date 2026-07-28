#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
podman compose up -d
echo "connect at postgres://postgres:postgres@localhost:5433/dev_db"
echo "test db at postgres://postgres:postgres@localhost:5434/test_db"
trap "podman compose down" EXIT
while true; do sleep 1; done
