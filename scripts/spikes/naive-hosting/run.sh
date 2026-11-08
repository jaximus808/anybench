#!/bin/sh
# Wrapper: loads secrets from the repo .env into the process env only; never echoes them.
# ENV_FILE defaults to the main checkout's .env (worktrees share it via the common git dir).
# Live Naïve calls: this sets NAIVE_LIVE=1, so only run it when the planner authorised live spend.
: "${ENV_FILE:=$(dirname "$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)")/.env}"
exec env NAIVE_LIVE=1 node --env-file="$ENV_FILE" "$@"
