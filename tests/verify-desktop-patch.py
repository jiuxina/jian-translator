"""Targeted version-metadata checks; does not invoke builds or native APIs."""
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


if __name__ == "__main__":
    unittest.main()
