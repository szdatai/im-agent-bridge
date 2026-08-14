@echo off
rem WeCom <-> Claude Code Bridge 启动脚本
cd /d "%~dp0"
node --env-file-if-exists=.env bridge.mjs %*
