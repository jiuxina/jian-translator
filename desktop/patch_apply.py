#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把桌面增强补丁应用到本机 pake-cli 模板（幂等）。

- src/app/setup.rs：整文件替换（托盘 / 悬浮窗 / 设置 / 窗口动作 / 开机自启）
- src/lib.rs：注册自定义命令 + 启动到托盘读取用户设置
- build.rs：把命令写进应用 ACL 白名单
- capabilities/default.json：允许新命令（远程页面也复制这份权限）
- Cargo.toml：windows-sys 键盘 feature + tauri-runtime（拖拽缩放方向枚举）
"""
import os
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


def main():
    desktop = os.path.dirname(os.path.abspath(__file__))
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
        if '"it_get_settings"' not in build:
            build, _ = replace_once(
                build,
                '            "set_title_bar_color",\n        ]),',
                '            "set_title_bar_color",\n            "it_get_settings",\n'
                '            "it_save_settings",\n            "it_set_hotkeys_enabled",\n'
                '            "it_window_action",\n        ]),',
                "build.rs",
            )
        elif '"it_window_action"' not in build:
            build, _ = replace_once(
                build,
                '            "it_set_hotkeys_enabled",\n        ]),',
                '            "it_set_hotkeys_enabled",\n'
                '            "it_window_action",\n        ]),',
                "build.rs",
                required=False,
            )
        if build != original:
            write(build_path, build)
            print("已更新 build.rs")
        else:
            print("build.rs 已包含新命令")

        # 3b. build.rs 增加调试命令
        build = read(build_path)
        original = build
        build, _ = replace_once(
            build,
            '            "it_window_action",\n        ]),',
            '            "it_window_action",\n            "it_debug_log",\n        ]),',
            "build.rs debug",
            required=False,
        )
        if build != original:
            write(build_path, build)
            print("build.rs 已加入 it_debug_log")

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

        # 5. Cargo.toml
        cargo_path = os.path.join(tauri, "Cargo.toml")
        cargo = read(cargo_path)
        original = cargo
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
            "Win32_Storage_FileSystem",
            "Win32_System_DataExchange",
            "Win32_System_Memory",
            "Win32_System_Ole",
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
