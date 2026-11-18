"""Targeted patch checks; does not invoke builds or native APIs."""
import importlib.util
from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
