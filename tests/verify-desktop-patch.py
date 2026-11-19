"""Targeted patch checks; does not invoke builds or native APIs."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import unittest
from unittest import mock


PATCHER_PATH = Path(__file__).resolve().parents[1] / "desktop" / "patch_apply.py"
SPEC = importlib.util.spec_from_file_location("desktop_patch_apply", PATCHER_PATH)
PATCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCHER)


class DesktopPackageVersionTests(unittest.TestCase):
    def test_changes_only_package_version_and_is_idempotent(self):
        source = (
            '[package]\nname = "pake"\nversion = "3.18.0" # template\n\n'
            '[package.metadata]\nversion = "7.0.0"\n\n'
            '[dependencies]\nexample = { version = "3.18.0" }\n'
        )
        expected = source.replace('version = "3.18.0" # template',
                                  'version = "2.2.0" # template', 1)
        actual = PATCHER.set_package_version(source, "2.2.0")
        self.assertEqual(actual, expected)
        self.assertEqual(PATCHER.set_package_version(actual, "2.2.0"), actual)

    def test_preserves_literal_quotes_whitespace_and_crlf(self):
        source = "[package]\r\nname='pake'\r\n  version\t= '3.18.0'  \r\n[lib]\r\n"
        self.assertEqual(
            PATCHER.set_package_version(source, "2.2.0"),
            source.replace("'3.18.0'", "'2.2.0'", 1),
        )

    def test_missing_or_ambiguous_package_section_fails(self):
        for source in (
            '[dependencies]\nversion = "3.18.0"\n',
            '[package]\nversion = "3.18.0"\n[package]\nversion = "1.0.0"\n',
        ):
            with self.subTest(source=source), self.assertRaises(RuntimeError):
                PATCHER.set_package_version(source, "2.2.0")

    def test_missing_duplicate_or_inherited_package_version_fails(self):
        for source in (
            '[package]\nname = "pake"\n',
            '[package]\nversion = "3.18.0"\nversion = "3.17.0"\n',
            '[package]\nversion.workspace = true\n',
            '[package]\nversion.workspace = true\nversion = "3.18.0"\n',
            '[package]\nversion = 318\n',
        ):
            with self.subTest(source=source), self.assertRaises(RuntimeError):
                PATCHER.set_package_version(source, "2.2.0")

    def test_rejects_non_release_and_installer_incompatible_versions(self):
        for version in (
            None, 220, "", "v2.2.0", "2.2", "2.2.0-beta", "2.2.0+test",
            "02.2.0", "2.02.0", "2.2.00", "2.2.0\n", "256.2.0", "2.256.0",
            "2.2.65536",
        ):
            with self.subTest(version=version), self.assertRaises(RuntimeError):
                PATCHER.set_package_version('[package]\nversion = "3.18.0"\n', version)

    def test_accepts_installer_boundary_version(self):
        self.assertEqual(
            PATCHER.set_package_version('[package]\nversion = "3.18.0"\n', "255.255.65535"),
            '[package]\nversion = "255.255.65535"\n',
        )

    def test_manifest_version_is_read_without_altering_manifest(self):
        with mock.patch.object(
                PATCHER, "read",
                return_value='{"version":"2.2.0","license":"unchanged"}') as read:
            self.assertEqual(PATCHER.read_app_version("package.json"), "2.2.0")
            read.assert_called_once_with("package.json")

    def test_invalid_manifest_fails_with_release_error(self):
        for content in ("not-json", "[]", "null", "{}", '{"version":"v2.2.0"}'):
            with self.subTest(content=content), mock.patch.object(
                    PATCHER, "read", return_value=content), self.assertRaises(RuntimeError):
                PATCHER.read_app_version("package.json")


class DesktopPopupRevealTests(unittest.TestCase):
    SOURCE = (
        "pub fn hide_all_app_windows(app: &AppHandle) {\n"
        "    for window in app.webview_windows().values() {\n"
        "        let _ = window.hide();\n"
        "    }\n"
        "}\n\n"
        "pub fn show_all_app_windows(app: &AppHandle, init_fullscreen: bool) {\n"
        "    let windows = app.webview_windows();\n"
        "    for window in windows.values() {\n"
        "        let _ = window.unminimize();\n"
        "        let _ = window.show();\n"
        "        reapply_window_icon(window);\n"
        "        #[cfg(target_os = \"linux\")]\n"
        "        if init_fullscreen && !window.is_fullscreen().unwrap_or(false) {\n"
        "            let _ = window.set_fullscreen(true);\n"
        "        }\n"
        "    }\n"
        "    #[cfg(not(target_os = \"linux\"))]\n"
        "    let _ = init_fullscreen;\n"
        "    if let Some(main) = windows.get(\"pake\") {\n"
        "        let _ = main.set_focus();\n"
        "    } else if let Some(any) = windows.values().next() {\n"
        "        let _ = any.set_focus();\n"
        "    }\n"
        "}\n\n"
        "pub fn toggle_all_app_windows(app: &AppHandle, init_fullscreen: bool) {\n"
        "    if any_app_window_visible(app) {\n"
        "        hide_all_app_windows(app);\n"
        "    } else {\n"
        "        show_all_app_windows(app, init_fullscreen);\n"
        "    }\n"
        "}\n"
    )

    def test_excludes_only_popup_from_show_and_fallback_focus(self):
        actual = PATCHER.exclude_popup_from_window_reveal(self.SOURCE)
        expected = self.SOURCE.replace(
            "    for window in windows.values() {\n",
            "    for window in windows.values() {\n"
            '        if window.label() == "pake-popup" {\n'
            "            continue;\n"
            "        }\n", 1,
        ).replace(
            "    } else if let Some(any) = windows.values().next() {",
            "    } else if let Some(any) = windows\n"
            "        .values()\n"
            '        .find(|window| window.label() != "pake-popup")\n'
            "    {", 1,
        )
        self.assertEqual(actual, expected)
        self.assertEqual(actual.count('window.label() == "pake-popup"'), 1)
        self.assertEqual(actual.count('window.label() != "pake-popup"'), 1)
        self.assertEqual(PATCHER.exclude_popup_from_window_reveal(actual), actual)

    def test_preserves_crlf_and_does_not_touch_other_reveal_loops(self):
        unrelated = (
            "pub fn show_unrelated_windows() {\n"
            "    for window in windows.values() {\n"
            "        let _ = window.show();\n"
            "    }\n"
            "}\n\n"
        )
        source = (unrelated + self.SOURCE).replace("\n", "\r\n")
        actual = PATCHER.exclude_popup_from_window_reveal(source)
        self.assertTrue(actual.startswith(unrelated.replace("\n", "\r\n")))
        self.assertNotIn("\n", actual.replace("\r\n", ""))
        self.assertEqual(PATCHER.exclude_popup_from_window_reveal(actual), actual)

    def test_missing_or_ambiguous_reveal_function_fails(self):
        for source in ("pub fn unrelated() {}\n", self.SOURCE + self.SOURCE):
            with self.subTest(source=source), self.assertRaises(RuntimeError):
                PATCHER.exclude_popup_from_window_reveal(source)

    def test_changed_or_incomplete_reveal_body_fails_before_returning(self):
        for source in (
            self.SOURCE.replace("for window in windows.values()", "for window in other.values()"),
            self.SOURCE.replace("windows.values().next()", "fallback_window()"),
            "pub fn show_all_app_windows(app: &AppHandle, init_fullscreen: bool) {\n",
        ):
            with self.subTest(source=source), self.assertRaises(RuntimeError):
                PATCHER.exclude_popup_from_window_reveal(source)


class DesktopAutostartContractTests(unittest.TestCase):
    ROOT = Path(__file__).resolve().parents[1]

    def test_registry_reader_returns_path_and_checks_current_executable(self):
        source = (self.ROOT / "desktop" / "patch" / "setup.rs").read_text(encoding="utf-8")
        self.assertIn("pub struct AutostartStatus", source)
        self.assertIn("pub fn it_get_autostart_status(", source)
        self.assertIn("target_path", source)
        self.assertIn("target_is_current", source)
        self.assertIn("target_exists", source)

    def test_autostart_writes_are_separate_from_general_settings_persistence(self):
        source = (self.ROOT / "desktop" / "patch" / "setup.rs").read_text(encoding="utf-8")
        start = source.index("pub fn it_save_settings(")
        end = source.index("\npub fn set_system_tray(", start)
        save = source[start:end]
        self.assertNotIn("apply_autostart", save)
        self.assertNotIn("auto_start_changed", save)
        self.assertIn("pub fn it_set_autostart(", source)

    def test_patch_registers_autostart_commands_in_lib_acl_and_capability(self):
        patcher = (self.ROOT / "desktop" / "patch_apply.py").read_text(encoding="utf-8")
        for command in ("it_get_autostart_status", "it_set_autostart"):
            with self.subTest(command=command):
                self.assertIn(command, patcher)
                self.assertIn('"%s"' % command, patcher)
                self.assertIn('"allow-%s"' % command.replace("_", "-"), patcher)


class DesktopStartupDefaultsTests(unittest.TestCase):
    ROOT = Path(__file__).resolve().parents[1]

    def test_startup_toggles_default_to_off_and_build_does_not_force_tray_start(self):
        rust = (self.ROOT / "desktop" / "patch" / "setup.rs").read_text(encoding="utf-8")
        frontend = (self.ROOT / "web" / "app.js").read_text(encoding="utf-8")
        macos = (self.ROOT / "app" / "macos" / "core.cjs").read_text(encoding="utf-8")
        build = (self.ROOT / "app" / "rebuild.sh").read_text(encoding="utf-8")
        self.assertIn("auto_start: false", rust)
        self.assertIn("start_to_tray: false", rust)
        self.assertIn("auto_start: false, start_to_tray: false", frontend)
        self.assertIn("start_to_tray: false", macos)
        self.assertNotIn("--start-to-tray", build)

    def test_saved_start_to_tray_setting_still_overrides_new_default(self):
        source = (self.ROOT / "desktop" / "patch" / "setup.rs").read_text(encoding="utf-8")
        self.assertIn('value.get("start_to_tray").and_then(|flag| flag.as_bool())', source)
        self.assertIn('unwrap_or(cli_default)', source)


class DesktopInstallerLifecycleTests(unittest.TestCase):
    def test_actions_are_inserted_once_inside_product_and_upgraded(self):
        source = '<Wix>\n    <Product Id="*">\n    </Product>\n</Wix>\n'
        actual = PATCHER.install_autostart_wix(source, '<CustomAction Id="first" />\n')
        self.assertIn('<CustomAction Id="first" />', actual)
        self.assertLess(actual.index('JIAN_AUTOSTART_BEGIN'), actual.index('</Product>'))
        self.assertEqual(PATCHER.install_autostart_wix(actual, '<CustomAction Id="first" />\n'), actual)
        updated = PATCHER.install_autostart_wix(actual, '<CustomAction Id="next" />\n')
        self.assertNotIn('Id="first"', updated)
        self.assertEqual(updated.count('JIAN_AUTOSTART_BEGIN'), 1)
        self.assertIn('Id="next"', updated)

    def test_missing_ambiguous_or_damaged_templates_fail_closed(self):
        for source in ('<Wix />', '</Product>\n</Product>',
                       '        <!-- JIAN_AUTOSTART_BEGIN -->\n    </Product>'):
            with self.subTest(source=source), self.assertRaises(RuntimeError):
                PATCHER.install_autostart_wix(source, '')


class DesktopAutostartPatchTests(unittest.TestCase):
    COMMANDS = ("it_get_autostart_status", "it_set_autostart")
    HANDLER_PATTERN = r"(?ms)tauri::generate_handler!\[.*?^        \]\)"
    LIB = (
        "use app::{\n"
        "    setup::{set_global_shortcut, set_system_tray},\n"
        "    window::{set_window},\n"
        "};\n"
        "fn run() {\n"
        "    let start_to_tray = pake_config.windows[0].start_to_tray && show_system_tray; // Only valid when tray is enabled\n"
        "    builder.invoke_handler(tauri::generate_handler![\n"
        "            set_title_bar_color,\n"
        "        ])\n"
        "        .setup(move |app| { Ok(()) });\n"
        "}\n"
    )
    BUILD = (
        "fn main() {\n"
        "    tauri_build::AppManifest::new().commands(&[\n"
        '            "set_title_bar_color",\n'
        "        ]);\n"
        "}\n"
    )

    def run_patch(self, lib=None, build=None, capability=None):
        desktop = str(PATCHER_PATH.parent)
        tauri = os.path.join(desktop, "synthetic-npm", "pake-cli", "src-tauri")
        paths = {
            name: os.path.normpath(os.path.join(tauri, relative))
            for name, relative in {
                "lib": "src/lib.rs", "build": "build.rs",
                "capability": "capabilities/default.json", "cargo": "Cargo.toml",
            }.items()
        }
        files = {
            paths["lib"]: self.LIB if lib is None else lib,
            paths["build"]: self.BUILD if build is None else build,
            paths["capability"]: capability if capability is not None else json.dumps({
                "identifier": "fixture", "webviews": ["pake", "pake-*"],
                "permissions": ["allow-set-title-bar-color", "shell:allow-open"],
            }, indent=2),
            paths["cargo"]: (
                '[package]\nname = "synthetic"\nversion = "3.18.0"\n'
                '[dependencies]\nserde_json = "1.0.149"\n'
                'features = [\n  "Win32_UI_WindowsAndMessaging",\n]\n'
            ),
            os.path.normpath(os.path.join(tauri, "src/app/window.rs")): DesktopPopupRevealTests.SOURCE,
            os.path.normpath(os.path.join(tauri, "assets/main.wxs")): (
                '<Wix><Product>\n    </Product></Wix>\n'
            ),
            os.path.normpath(os.path.join(desktop, "patch/autostart.wxi")): (
                '<CustomAction Id="JianUpdateAutostart" />\n'
            ),
            os.path.normpath(os.path.join(desktop, "patch/setup.rs")): "\n".join(
                "pub fn %s() {}" % command for command in self.COMMANDS + (
                    "it_list_system_fonts", "it_write_clipboard_text",
                )),
            os.path.normpath(os.path.join(desktop, "../app/macos/package.json")): '{"version":"2.3.0"}',
        }

        def read(path):
            return files[os.path.normpath(path)].replace("\r\n", "\n")

        def write(path, text):
            files[os.path.normpath(path)] = text

        stream = io.StringIO()
        with mock.patch.object(PATCHER, "read", side_effect=read), \
                mock.patch.object(PATCHER, "write", side_effect=write), \
                mock.patch.object(PATCHER.shutil, "copyfile"), \
                mock.patch.object(PATCHER.os.path, "isdir", return_value=True), \
                mock.patch.object(PATCHER.subprocess, "check_output",
                                  return_value=os.path.dirname(os.path.dirname(tauri))), \
                contextlib.redirect_stdout(stream), contextlib.redirect_stderr(stream):
            result = PATCHER.main()
        return result, {name: files[path] for name, path in paths.items()}, stream.getvalue()

    def assert_registered_once(self, output):
        for command in self.COMMANDS:
            self.assertEqual(len(re.findall(r"\b%s\b" % command, output["lib"])), 2)
            self.assertEqual(output["build"].count('"%s"' % command), 1)
            permission = "allow-" + command.replace("_", "-")
            self.assertEqual(json.loads(output["capability"])["permissions"].count(permission), 1)

    def test_fresh_template_then_repeated_application_register_once(self):
        status, output, report = self.run_patch()
        self.assertEqual(status, 0, report)
        self.assert_registered_once(output)
        status, repeated, report = self.run_patch(output["lib"], output["build"], output["capability"])
        self.assertEqual(status, 0, report)
        self.assertEqual(repeated, output)

    def test_pre_autostart_and_crlf_templates_upgrade_without_duplicate_commands(self):
        status, output, report = self.run_patch()
        self.assertEqual(status, 0, report)
        for command in self.COMMANDS:
            output["lib"] = re.sub(r"(?m)^ +%s,\n" % command, "", output["lib"])
            output["build"] = re.sub(r'(?m)^ +"%s",\n' % command, "", output["build"])
        capability = json.loads(output["capability"])
        capability["permissions"] = [
            name for name in capability["permissions"]
            if name not in ("allow-it-get-autostart-status", "allow-it-set-autostart")
        ]
        output["capability"] = json.dumps(capability, indent=2)
        for newline in ("\n", "\r\n"):
            with self.subTest(newline=newline):
                status, repaired, report = self.run_patch(
                    *(output[name].replace("\n", newline) for name in ("lib", "build", "capability")),
                )
                self.assertEqual(status, 0, report)
                self.assert_registered_once(repaired)

    def test_partial_registration_is_completed_without_duplicates(self):
        status, output, report = self.run_patch()
        self.assertEqual(status, 0, report)
        for command in self.COMMANDS:
            partial = dict(output)
            partial["lib"] = re.sub(r"(?m)^ +%s,\n" % command, "", partial["lib"])
            partial["build"] = re.sub(r'(?m)^ +"%s",\n' % command, "", partial["build"])
            capability = json.loads(partial["capability"])
            capability["permissions"].remove("allow-" + command.replace("_", "-"))
            partial["capability"] = json.dumps(capability, indent=2)
            status, repaired, report = self.run_patch(partial["lib"], partial["build"], partial["capability"])
            self.assertEqual(status, 0, report)
            self.assert_registered_once(repaired)

    def test_command_insertion_preserves_indentation_crlf_and_exact_names(self):
        source = (
            "builder.invoke_handler(tauri::generate_handler![\r\n"
            "            it_set_autostart_debug,\r\n"
            "            // it_get_autostart_status is registered below.\r\n"
            "        ])\r\n"
        )
        expected = source.replace(
            "        ])",
            "            it_get_autostart_status,\r\n"
            "            it_set_autostart,\r\n        ])",
        )
        actual = PATCHER.ensure_command_names(source, self.HANDLER_PATTERN,
                                             self.COMMANDS, "handler", quoted=False)
        self.assertEqual(actual, expected)
        self.assertEqual(PATCHER.ensure_command_names(actual, self.HANDLER_PATTERN,
                                                    self.COMMANDS, "handler", quoted=False), actual)

    def test_invalid_or_duplicate_list_fails_clearly(self):
        for source in (
            "missing handler", self.LIB + self.LIB,
            self.LIB.replace("set_title_bar_color,", "it_set_autostart,\n            it_set_autostart,"),
        ):
            with self.subTest(source=source), self.assertRaises(RuntimeError):
                PATCHER.ensure_command_names(source, self.HANDLER_PATTERN,
                                             self.COMMANDS, "handler", quoted=False)

    def test_single_line_setup_import_preserves_neighbors_and_crlf(self):
        source = self.LIB.replace("\n", "\r\n")
        actual = PATCHER.canonical_setup_import(source)
        self.assertIn("    window::{set_window},\r\n", actual)
        self.assertNotIn("\n", actual.replace("\r\n", ""))
        self.assertEqual(PATCHER.canonical_setup_import(actual), actual)

    def test_main_reports_changed_handler_or_acl_without_succeeding(self):
        for lib, build in (
            (self.LIB.replace("tauri::generate_handler![", "unknown_handler!["), None),
            (None, self.BUILD.replace(".commands(&[", ".unknown_commands(&[")),
        ):
            with self.subTest(lib=lib, build=build):
                status, _, report = self.run_patch(lib=lib, build=build)
                self.assertEqual(status, 1)
                self.assertIn("命令列表", report)

    def test_setup_import_rejects_missing_duplicate_and_malformed_blocks(self):
        for source in (
            "use unrelated;\n", self.LIB + self.LIB,
            self.LIB.replace("set_global_shortcut, set_system_tray", "set_global_shortcut, set_global_shortcut"),
            self.LIB.replace("set_global_shortcut, set_system_tray", "set_global_shortcut as renamed"),
        ):
            with self.subTest(source=source), self.assertRaises(RuntimeError):
                PATCHER.canonical_setup_import(source)


if __name__ == "__main__":
    unittest.main()
