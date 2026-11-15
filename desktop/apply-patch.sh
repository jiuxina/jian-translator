#!/usr/bin/env bash
# 把 Index-Translate 的桌面增强补丁应用到本机 pake-cli 模板。
# Pake 每次构建都会把 src-tauri 复制进临时工作区，所以补丁要打在全局模板上；
# 这里保留完整补丁文件，pake-cli 升级后重新运行本脚本即可恢复。
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })"

python "$DESKTOP_DIR/patch_apply.py"
