#!/bin/sh
# Render proxy routes and /_paseo/hosts.json from the declared inventory, check
# the result, then serve. An invalid inventory stops the container before
# nginx starts, so the healthcheck never passes on stale or default config.
set -eu

node /usr/local/lib/paseo/generate-config.mjs
nginx -t
exec nginx -g 'daemon off;'
