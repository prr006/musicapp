#!/bin/sh
set -eu

# Railway persistent volumes are mounted at runtime and may initially be owned
# by root, shadowing the ownership prepared in the image. Fix only the configured
# data-directory root, then permanently drop privileges before starting MELO.
data_dir=${MELO_DATA_DIR:-/data}
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$data_dir"
  chown melo:melo "$data_dir"
  exec gosu melo "$@"
fi

exec "$@"
