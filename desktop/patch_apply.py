#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把桌面增强补丁应用到本机 pake-cli 模板（幂等）。

- src/app/setup.rs + liquid-glass.js：替换桌面集成并注入共享液态玻璃滤镜
- src/app/window.rs：主窗口唤起时不显示预热的划词浮窗
- src/lib.rs：注册自定义命令 + 启动到托盘读取用户设置
- build.rs：把命令写进应用 ACL 白名单
- capabilities/default.json：允许新命令（远程页面也复制这份权限）
- Cargo.toml：应用版本元数据 + windows-sys feature + tauri-runtime
"""
import json
import os
import re
import shutil
import subprocess
import sys


def read(path):
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def write(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def replace_once(text, old, new, label, required=True):
    if new in text:
        return text, False
    if old not in text:
        if required:
            raise RuntimeError("%s：找不到插入锚点" % label)
        return text, False
    return text.replace(old, new, 1), True


def ensure_command_names(source, pattern, commands, label, quoted=True):
    """Append missing standalone list entries without changing existing entries."""
    matches = list(re.finditer(pattern, source, re.DOTALL))
    if len(matches) != 1:
        raise RuntimeError("%s 必须且只能匹配一个命令列表" % label)
    match = matches[0]
    block = match.group(0)
    missing = []
    for command in commands:
        token = '"%s"' % command if quoted else command
        entries = re.findall(
            r"(?m)^[ \t]*%s[ \t]*,?[ \t]*(?://[^\r\n]*)?\r?$" % re.escape(token),
            block,
        )
        if len(entries) > 1:
            raise RuntimeError("%s 出现重复命令：%s" % (label, command))
        if not entries:
            missing.append(token)
    if not missing:
        return source
    closing = re.search(r"(?m)^([ \t]*)\]", block)
    if closing is None:
        raise RuntimeError("%s 缺少独立结束行" % label)
    newline = "\r\n" if "\r\n" in block else "\n"
    indent = closing.group(1) + "    "
    insertion = "".join(indent + token + "," + newline for token in missing)
    updated = block[:closing.start()] + insertion + block[closing.start():]
    return source[:match.start()] + updated + source[match.end():]


def canonical_setup_import(source):
    pattern = r"(?m)^[ \t]+setup::\{([^{}]*)\},"
    matches = list(re.finditer(pattern, source))
    if len(matches) != 1:
        raise RuntimeError("lib.rs 必须且只能包含一个 setup 导入块")
    match = matches[0]
    names = [name.strip() for name in match.group(1).split(",") if name.strip()]
    if any(not re.fullmatch(r"[A-Za-z_]\w*", name) for name in names):
        raise RuntimeError("lib.rs setup 导入块包含无法识别的条目")
    if len(names) != len(set(names)):
        raise RuntimeError("lib.rs setup 导入块包含重复条目")
    for name in (
        "it_debug_log", "it_get_autostart_status", "it_get_settings", "it_list_system_fonts",
        "it_save_settings", "it_set_autostart", "it_set_hotkeys_enabled", "it_window_action",
        "it_write_clipboard_text", "set_global_shortcut", "set_system_tray",
    ):
        if name not in names:
            names.append(name)
    names.sort()
    newline = "\r\n" if "\r\n" in source else "\n"
    grouped = []
    for name in names:
        if not grouped or len(grouped[-1]) >= 4:
            grouped.append([])
        grouped[-1].append(name)
    body = ["        " + " ".join(name + "," for name in group) for group in grouped]
    block = newline.join(("    setup::{", *body, "    },"))
    return source[:match.start()] + block + source[match.end():]


_RELEASE_VERSION = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"
)
_PACKAGE_HEADER = re.compile(r"^\s*\[package\]\s*(?:#.*)?(?:\r?\n)?$")
_SECTION_HEADER = re.compile(r"^\s*\[[^\]]+\]\s*(?:#.*)?(?:\r?\n)?$")
_PACKAGE_VERSION = re.compile(
    r"^(\s*version\s*=\s*)([\"'])([^\"']+)(\2)(\s*(?:#.*)?)((?:\r?\n)?)$"
)


def validate_release_version(value):
    if not isinstance(value, str) or not _RELEASE_VERSION.fullmatch(value):
        raise RuntimeError("应用版本必须是三段正式语义版本（例如 2.2.0）")
    major, minor, patch = (int(part) for part in value.split("."))
    # Windows Installer ProductVersion uses 8-bit major/minor and 16-bit patch.
    if major > 255 or minor > 255 or patch > 65535:
        raise RuntimeError("应用版本超出 Windows 安装包版本范围")
    return value


def read_app_version(package_path):
    try:
        manifest = json.loads(read(package_path))
    except (OSError, ValueError) as error:
        raise RuntimeError("无法读取 macOS 应用版本清单：%s" % error) from error
    if not isinstance(manifest, dict):
        raise RuntimeError("macOS 应用版本清单必须是 JSON 对象")
    return validate_release_version(manifest.get("version"))


def set_package_version(cargo, version):
    version = validate_release_version(version)
    lines = cargo.splitlines(keepends=True)
    package_headers = [index for index, line in enumerate(lines)
                       if _PACKAGE_HEADER.fullmatch(line)]
    if len(package_headers) != 1:
        raise RuntimeError("Cargo.toml 必须包含且只能包含一个 [package] 区段")
    package_start = package_headers[0]
    package_end = next(
        (index for index in range(package_start + 1, len(lines))
         if _SECTION_HEADER.fullmatch(lines[index])),
        len(lines),
    )
    version_lines = [
        index for index in range(package_start + 1, package_end)
        if re.match(r"^\s*version(?:\s*=|\.)", lines[index])
    ]
    assignments = []
    for index in version_lines:
        match = _PACKAGE_VERSION.fullmatch(lines[index])
        if match:
            assignments.append((index, match))
        elif re.match(r"^\s*version\s*=", lines[index]):
            raise RuntimeError("[package] 的 version 必须是带引号的三段版本")
    if len(version_lines) != 1 or len(assignments) != 1:
        raise RuntimeError("[package] 必须包含且只能包含一个 version 字段")
    index, match = assignments[0]
    lines[index] = "%s%s%s%s%s%s" % (
        match.group(1), match.group(2), version, match.group(4),
        match.group(5), match.group(6),
    )
    return "".join(lines)


def exclude_popup_from_window_reveal(source):
    """Keep the warm auxiliary popup out of the main-window reveal path."""
    headers = list(re.finditer(
        r"(?m)^pub fn show_all_app_windows\([^\r\n]*\) \{\r?$", source,
    ))
    if len(headers) != 1:
        raise RuntimeError("window.rs 必须包含且只能包含一个 show_all_app_windows 函数")
    start = headers[0].start()
    closing = re.search(r"(?m)^}\r?$", source[headers[0].end():])
    if closing is None:
        raise RuntimeError("window.rs 的 show_all_app_windows 函数缺少结束位置")
    end = headers[0].end() + closing.end()
    body = source[start:end]
    newline = "\r\n" if "\r\n" in body else "\n"
    loop = "    for window in windows.values() {" + newline
    guarded_loop = (
        loop
        + '        if window.label() == "pake-popup" {' + newline
        + "            continue;" + newline
        + "        }" + newline
    )
    fallback = "    } else if let Some(any) = windows.values().next() {"
    guarded_fallback = newline.join((
        "    } else if let Some(any) = windows",
        "        .values()",
        '        .find(|window| window.label() != "pake-popup")',
        "    {",
    ))
    for original, replacement, label in (
        (loop, guarded_loop, "主窗口显示循环"),
        (fallback, guarded_fallback, "主窗口回退焦点"),
    ):
        if replacement in body:
            if body.count(replacement) != 1:
                raise RuntimeError("window.rs 的%s补丁出现重复" % label)
        elif body.count(original) == 1:
            body = body.replace(original, replacement, 1)
        else:
            raise RuntimeError("window.rs 的%s找不到唯一插入锚点" % label)
    return source[:start] + body + source[end:]


def main():
    desktop = os.path.dirname(os.path.abspath(__file__))
    package_path = os.path.join(os.path.dirname(desktop), "app", "macos", "package.json")
    try:
        app_version = read_app_version(package_path)
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1
    try:
        pake_root = subprocess.check_output(
            ["npm", "root", "-g"], text=True, shell=True
        ).strip()
    except Exception as error:  # noqa: BLE001
        print("找不到 npm 全局目录：%s" % error, file=sys.stderr)
        return 1

    tauri = os.path.join(pake_root, "pake-cli", "src-tauri")
    if not os.path.isdir(tauri):
        print("找不到 pake-cli 模板：%s" % tauri, file=sys.stderr)
        return 1

    try:
        # 1. setup.rs 全量替换
        shutil.copyfile(
            os.path.join(desktop, "patch", "setup.rs"),
            os.path.join(tauri, "src", "app", "setup.rs"),
        )
        print("已更新 setup.rs")
        shutil.copyfile(
            os.path.join(os.path.dirname(desktop), "web", "liquid-glass.js"),
            os.path.join(tauri, "src", "app", "liquid-glass.js"),
        )
        print("已更新 liquid-glass.js")

        window_path = os.path.join(tauri, "src", "app", "window.rs")
        window_source = read(window_path)
        window_updated = exclude_popup_from_window_reveal(window_source)
        if window_updated != window_source:
            write(window_path, window_updated)
            print("已排除主窗口唤起路径中的预热浮窗")
        else:
            print("主窗口唤起已排除预热浮窗")

        # 2. lib.rs：导入 + 注册命令
        lib_path = os.path.join(tauri, "src", "lib.rs")
        lib = read(lib_path)
        original = lib
        if "it_get_settings" not in lib:
            lib, _ = replace_once(
                lib,
                "    setup::{set_global_shortcut, set_system_tray},",
                "    setup::{\n        it_get_settings, it_save_settings, it_set_hotkeys_enabled,\n"
                "        it_window_action, set_global_shortcut, set_system_tray,\n    },",
                "lib.rs 导入",
            )
            lib, _ = replace_once(
                lib,
                "            set_title_bar_color,\n        ])",
                "            set_title_bar_color,\n            it_get_settings,\n"
                "            it_save_settings,\n            it_set_hotkeys_enabled,\n"
                "            it_window_action,\n        ])",
                "lib.rs 命令列表",
            )
        else:
            lib, _ = replace_once(
                lib,
                "it_set_hotkeys_enabled, set_global_shortcut,",
                "it_set_hotkeys_enabled, it_window_action, set_global_shortcut,",
                "lib.rs 导入",
                required=False,
            )
            lib, _ = replace_once(
                lib,
                "            it_set_hotkeys_enabled,\n        ])",
                "            it_set_hotkeys_enabled,\n            it_window_action,\n        ])",
                "lib.rs 命令列表",
                required=False,
            )
        if lib != original:
            write(lib_path, lib)
            print("已更新 lib.rs")
        else:
            print("lib.rs 已是补丁版本")

        # 2b. 临时诊断命令 it_debug_log
        lib = read(lib_path)
        original = lib
        lib, _ = replace_once(
            lib,
            "it_window_action, set_global_shortcut,",
            "it_window_action, it_debug_log, set_global_shortcut,",
            "lib.rs debug 导入",
            required=False,
        )
        lib, _ = replace_once(
            lib,
            "            it_window_action,\n        ])",
            "            it_window_action,\n            it_debug_log,\n        ])",
            "lib.rs debug 注册",
            required=False,
        )
        if lib != original:
            write(lib_path, lib)
            print("已注册 it_debug_log")

        # 2d. 注册 Windows 系统字体枚举和剪贴板写入命令
        lib = read(lib_path)
        original = lib
        if "it_list_system_fonts" not in lib or "it_write_clipboard_text" not in lib:
            lib, _ = replace_once(
                lib,
                "it_window_action, it_debug_log, set_global_shortcut,",
                "it_window_action, it_debug_log, it_list_system_fonts,\n"
                "        it_write_clipboard_text, set_global_shortcut,",
                "lib.rs 原生桌面命令导入",
                required=False,
            )
            lib, _ = replace_once(
                lib,
                "            it_debug_log,\n        ])",
                "            it_debug_log,\n"
                "            it_list_system_fonts,\n"
                "            it_write_clipboard_text,\n        ])",
                "lib.rs 原生命令注册",
                required=False,
            )
        lib = canonical_setup_import(lib)
        lib = ensure_command_names(
            lib,
            r"(?ms)tauri::generate_handler!\[.*?^        \]\)",
            (
                "it_get_autostart_status", "it_get_settings", "it_save_settings",
                "it_set_autostart", "it_set_hotkeys_enabled", "it_window_action",
                "it_debug_log", "it_list_system_fonts", "it_write_clipboard_text",
            ),
            "lib.rs 命令列表",
            quoted=False,
        )
        if lib != original:
            write(lib_path, lib)
            print("已注册系统字体与剪贴板命令")

        # 2c. 启动到托盘：构建期常量改由用户设置覆盖
        lib = read(lib_path)
        original = lib
        lib, _ = replace_once(
            lib,
            "    let start_to_tray = pake_config.windows[0].start_to_tray && show_system_tray; // Only valid when tray is enabled",
            "    // 启动到托盘可在设置面板切换，见 setup.rs::start_to_tray_enabled\n"
            "    let start_to_tray = app::setup::start_to_tray_enabled(\n"
            "        pake_config.windows[0].start_to_tray && show_system_tray,\n"
            "        &tauri_config.identifier,\n"
            "    );",
            "lib.rs 启动到托盘",
        )
        if lib != original:
            write(lib_path, lib)
            print("已让启动到托盘读取用户设置")

        # 3. build.rs 应用 ACL 白名单
        build_path = os.path.join(tauri, "build.rs")
        build = read(build_path)
        original = build
        build = ensure_command_names(
            build,
            r"(?ms)AppManifest::new\(\)\.commands\(&\[.*?^        \]\)",
            (
                "it_get_autostart_status", "it_get_settings", "it_save_settings",
                "it_set_autostart", "it_set_hotkeys_enabled", "it_window_action",
                "it_debug_log", "it_list_system_fonts", "it_write_clipboard_text",
            ),
            "build.rs 命令列表",
        )
        if build != original:
            write(build_path, build)
            print("已更新 build.rs")
        else:
            print("build.rs 已包含新命令")

        # 4. capabilities/default.json
        capability_path = os.path.join(tauri, "capabilities", "default.json")
        capability = read(capability_path)
        original = capability
        if '"allow-it-get-settings"' not in capability:
            capability, _ = replace_once(
                capability,
                '    "allow-set-title-bar-color",',
                '    "allow-set-title-bar-color",\n'
                '    "allow-it-get-settings",\n'
                '    "allow-it-save-settings",\n'
                '    "allow-it-set-hotkeys-enabled",\n'
                '    "allow-it-window-action",',
                "capabilities",
            )
        elif '"allow-it-window-action"' not in capability:
            capability, _ = replace_once(
                capability,
                '    "allow-it-set-hotkeys-enabled",',
                '    "allow-it-set-hotkeys-enabled",\n'
                '    "allow-it-window-action",',
                "capabilities",
                required=False,
            )
        if capability != original:
            write(capability_path, capability)
            print("已更新 capabilities/default.json")
        else:
            print("capabilities/default.json 已包含新权限")

        # 4b. capabilities 增加调试命令
        capability = read(capability_path)
        original = capability
        capability, _ = replace_once(
            capability,
            '    "allow-it-window-action",',
            '    "allow-it-window-action",\n    "allow-it-debug-log",',
            "capabilities debug",
            required=False,
        )
        if capability != original:
            write(capability_path, capability)
            print("capabilities 已加入 allow-it-debug-log")

        # 4c. capability 授权系统字体枚举和剪贴板写入
        capability = read(capability_path)
        original = capability
        capability, _ = replace_once(
            capability,
            '    "allow-it-debug-log",',
            '    "allow-it-debug-log",\n'
            '    "allow-it-list-system-fonts",\n'
            '    "allow-it-write-clipboard-text",',
            "capabilities 原生命令权限",
            required=False,
        )
        if capability != original:
            write(capability_path, capability)
            print("capabilities 已加入系统字体与剪贴板命令权限")

        # Autostart permissions may already be present independently in an older
        # partially patched template. Add each missing entry exactly once.
        try:
            manifest = json.loads(capability)
            permissions = manifest["permissions"]
        except (ValueError, KeyError, TypeError) as error:
            raise RuntimeError("capability 权限清单格式无效") from error
        if not isinstance(permissions, list):
            raise RuntimeError("capability permissions 必须为数组")
        changed = False
        for permission in ("allow-it-get-autostart-status", "allow-it-set-autostart"):
            count = permissions.count(permission)
            if count > 1:
                raise RuntimeError("capability 出现重复权限：%s" % permission)
            if count == 0:
                permissions.append(permission)
                changed = True
        if changed:
            capability = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
            write(capability_path, capability)
            print("capabilities 已加入自启动命令权限")

        # 5. Cargo.toml
        cargo_path = os.path.join(tauri, "Cargo.toml")
        cargo = read(cargo_path)
        original = cargo
        # tauri-winres inherits string version metadata from this Cargo package.
        # Keep npm's Pake CLI version intact; only the app package is versioned.
        cargo = set_package_version(cargo, app_version)
        if '"Win32_UI_Input_KeyboardAndMouse"' not in cargo:
            cargo, _ = replace_once(
                cargo,
                '  "Win32_UI_WindowsAndMessaging",',
                '  "Win32_UI_WindowsAndMessaging",\n'
                '  "Win32_UI_Input_KeyboardAndMouse",',
                "Cargo.toml feature",
            )
        if "tauri-runtime =" not in cargo:
            cargo, changed = replace_once(
                cargo,
                'serde_json = "1.0.149"',
                'serde_json = "1.0.149"\ntauri-runtime = "2.10.0"',
                "Cargo.toml tauri-runtime",
            )
        if '"Win32_System_Registry"' not in cargo:
            cargo, _ = replace_once(
                cargo,
                '  "Win32_UI_Input_KeyboardAndMouse",',
                '  "Win32_UI_Input_KeyboardAndMouse",\n'
                '  "Win32_System_Registry",',
                "Cargo.toml registry feature",
            )
        for feature in (
            "Win32_Graphics_Dwm",
            "Win32_Graphics_Gdi",
            "Win32_Storage_FileSystem",
            "Win32_System_DataExchange",
            "Win32_System_Environment",
            "Win32_System_Memory",
            "Win32_System_Ole",
            "Win32_Security",
            "Win32_UI_Controls",
            "Win32_UI_HiDpi",
            "Win32_UI_Shell",
            "Win32_UI_WindowsAndMessaging",
        ):
            marker = '"%s"' % feature
            if marker not in cargo:
                cargo, _ = replace_once(
                    cargo,
                    '  "Win32_System_Registry",',
                    '  "Win32_System_Registry",\n  %s,' % marker,
                    "Cargo.toml %s" % feature,
                    required=False,
                )
        setup_source = read(os.path.join(desktop, "patch", "setup.rs"))
        lib = read(lib_path)
        build = read(build_path)
        capability = read(capability_path)
        command_permissions = {
            "it_get_autostart_status": "allow-it-get-autostart-status",
            "it_set_autostart": "allow-it-set-autostart",
            "it_list_system_fonts": "allow-it-list-system-fonts",
            "it_write_clipboard_text": "allow-it-write-clipboard-text",
        }
        for command, permission in command_permissions.items():
            if "pub fn %s(" % command not in setup_source:
                raise RuntimeError("setup.rs 缺少原生命令：%s" % command)
            if lib.count(command) < 2:
                raise RuntimeError("lib.rs 未完整导入并注册原生命令：%s" % command)
            if '"%s"' % command not in build:
                raise RuntimeError("build.rs ACL 缺少原生命令：%s" % command)
            if '"%s"' % permission not in capability:
                raise RuntimeError("capability 缺少原生命令权限：%s" % permission)

        print("自启动、系统字体与剪贴板命令的导入、ACL 和 capability 已验证")

        if cargo != original:
            write(cargo_path, cargo)
            print("已更新 Cargo.toml")
        else:
            print("Cargo.toml 已是补丁版本")
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
