#!/usr/bin/env bash
# 重新打包「笺」桌面版
# Windows 依赖：Node 22+、Rust(MSVC)、pake-cli、WebView2
# macOS 依赖：Node 22+、app/macos 中 npm ci 安装的 Chromium 桌面壳构建依赖
#
# v2 起改为「自绘 UI + 官方公开 API」：
#   前端源码在本仓库根目录 web/，pake 以本地目录方式打包（入口 index.html），
#   不再加载官网页面、不再注入 CSS/JS。请求直连
#   https://index-translate.bilibili.com/v1/chat/completions（Apache-2.0 / 官方公开接口）。
#
# 电脑端托盘 / 划词翻译 / 悬浮窗依赖 desktop/patch/setup.rs，构建前会自动应用到 pake-cli 模板。
# 改完 web/ 下的文件后直接跑本脚本即可，无需改任何 pake 参数。
set -euo pipefail

# 用 Windows 风格绝对路径（pwd -W）：Git Bash 的 pwd 会给 /f/... 这种 POSIX 路径，
# Node 在 Windows 上会把它解析成 F:\f\...，导致 --icon / 本地目录找不到。
APP_DIR="$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })"
ROOT_DIR="$(cd "$(dirname "$0")/.." && { pwd -W 2>/dev/null || pwd; })"
OUT_DIR="${IT_OUT_DIR:-$ROOT_DIR/output}"
DESKTOP_DIR="$ROOT_DIR/desktop"
WEB_DIR="$ROOT_DIR/web"

case "$(uname -s)" in
  Darwin)
    # Safari/WKWebView 不支持参考的 SVG backdrop 链，Mac 使用同一 Chromium 光学实现。
    exec node "$APP_DIR/macos/build.mjs" "$@"
    ;;
esac

if [ ! -f "$WEB_DIR/index.html" ]; then
  echo "缺少 $WEB_DIR/index.html，自绘前端不完整" >&2
  exit 1
fi

bash "$DESKTOP_DIR/apply-patch.sh"

mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

# 本机全局 npm 目录不可写，打过补丁的 pake-cli 放在 .build/npm-global 下。
# 优先用这份，避免构建到未打补丁的全局模板；副本不存在时回退 PATH 里的 pake。
WORK_ROOT_WIN="$(cd "$ROOT_DIR" && { pwd -W 2>/dev/null || pwd; })"
PAKE_LOCAL="$ROOT_DIR/.build/npm-global/node_modules/pake-cli/dist/cli.js"
if [ -f "$PAKE_LOCAL" ]; then
  PAKE=(node "$WORK_ROOT_WIN/.build/npm-global/node_modules/pake-cli/dist/cli.js")
else
  PAKE=(pake)
fi

# 传目录即触发 pake 的本地打包：整棵 web/ 进资源，入口固定 index.html（url_type = local）。
"${PAKE[@]}" "$WEB_DIR" \
  --name "笺" \
  --title "笺" \
  --identifier "ink.jian.translate" \
  --icon "$APP_DIR/icon.ico" \
  --width 1180 \
  --height 900 \
  --no-restore-last-url \
  --keep-binary \
  --installer-language zh-CN \
  --app-version 2.4.3 \
  --show-system-tray \
  --system-tray-icon "$APP_DIR/icon.png" \
  --hide-on-close true \
  --hide-window-decorations \
  --activation-shortcut "Ctrl+Alt+I"
# 标题栏由 web/index.html 的 .titlebar 自绘（窗口内 40px），所以隐藏系统边框。
# 首次启动显示主窗口；用户可在「设置 → 启动后最小化到托盘」中启用托盘启动。
