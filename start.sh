#!/usr/bin/env bash
# WeCom ↔ Claude Code Bridge 启动脚本
cd "$(dirname "$0")" || exit 1
node --env-file-if-exists=.env bridge.mjs "$@"
