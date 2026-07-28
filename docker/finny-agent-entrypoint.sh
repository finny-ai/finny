#!/bin/sh
set -eu

exec finny serve --hostname 0.0.0.0 --port "${PORT:-8080}"
