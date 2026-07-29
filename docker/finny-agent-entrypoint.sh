#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
    install -d -o finny -g finny \
        /var/lib/finny \
        /var/lib/finny/workspace \
        /var/lib/finny/data \
        /var/lib/finny/cache \
        /var/lib/finny/config \
        /var/lib/finny/state
    exec gosu finny "$0" "$@"
fi

exec finny serve --hostname 0.0.0.0 --port "${PORT:-8080}"
