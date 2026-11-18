/* Runs production registry functions against a memory-only Win32 boundary. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const rustc = 'rustc';
const source = new TextDecoder('utf-8', { fatal: true })
  .decode(await readFile(path.join(root, 'desktop/patch/setup.rs'))).replace(/\r\n/g, '\n');
const start = source.indexOf('struct RunKey(');
assert.ok(start >= 0, 'Production registry handle must close on every return path');
const end = source.indexOf('/// 自定义标题栏', start);
let functions = source.slice(start, end);
functions = functions.replace(/#\[tauri::command\(async\)\][\s\S]*?(?=\n#\[|$)/g, '');
const structs = source.slice(source.lastIndexOf('#[derive(', source.indexOf('pub struct AutostartStatus')),
  source.indexOf('const DEFAULT_SELECTION_SHORTCUT'))
  .replace('#[derive(Clone, Debug, serde::Serialize)]', '#[derive(Clone, Debug)]');
const rust = String.raw`
#![allow(non_snake_case, non_upper_case_globals, dead_code)]
use std::path::{Path, PathBuf};
use std::fs;
use std::sync::Mutex;
const RUN_KEY: &str = "SyntheticRunKey";
const RUN_VALUE: &str = "SyntheticValue";
static AUTOSTART_LOCK: Mutex<()> = Mutex::new(());
fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }
${structs}
#[derive(Default)]
struct Registry {
    key: bool, value: Option<(u32, Vec<u8>)>, denied: bool, fail_write: bool,
    opens: usize, closes: usize, access: u32, changes: usize, grow: usize,
}
static REG: Mutex<Registry> = Mutex::new(Registry {
    key: false, value: None, denied: false, fail_write: false,
    opens: 0, closes: 0, access: 0, changes: 0, grow: 0,
});
mod windows_sys {
    pub mod Win32 {
        pub mod System {
            pub mod Registry {
                use crate::REG;
                pub type HKEY = *mut std::ffi::c_void;
                pub const HKEY_CURRENT_USER: HKEY = 1usize as HKEY;
                pub const KEY_QUERY_VALUE: u32 = 1;
                pub const KEY_SET_VALUE: u32 = 2;
                pub const REG_SZ: u32 = 1;
                pub const REG_EXPAND_SZ: u32 = 2;
                pub unsafe fn RegOpenKeyExW(_: HKEY, _: *const u16, _: u32, access: u32, out: *mut HKEY) -> u32 {
                    let mut r = REG.lock().unwrap();
                    if r.denied { return 5; }
                    if !r.key { return 2; }
                    r.opens += 1; r.access = access; unsafe { *out = HKEY_CURRENT_USER; } 0
                }
                pub unsafe fn RegCreateKeyExW(_: HKEY, _: *const u16, _: u32, _: *const u16,
                    _: u32, access: u32, _: *const std::ffi::c_void, out: *mut HKEY, _: *mut u32) -> u32 {
                    let mut r = REG.lock().unwrap();
                    if r.denied { return 5; }
                    r.key = true; r.opens += 1; r.access = access; unsafe { *out = HKEY_CURRENT_USER; } 0
                }
                pub unsafe fn RegQueryValueExW(_: HKEY, _: *const u16, _: *const u32, kind: *mut u32,
                    data: *mut u8, size: *mut u32) -> u32 {
                    let mut r = REG.lock().unwrap();
                    let Some((k, bytes)) = r.value.clone() else { return 2; };
                    unsafe { *kind = k; }
                    if !data.is_null() && r.grow > 0 {
                        r.grow -= 1; unsafe { *size += 2; } return 234;
                    }
                    if !data.is_null() {
                        if unsafe { *size } < bytes.len() as u32 { return 234; }
                        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), data, bytes.len()); }
                    }
                    unsafe { *size = bytes.len() as u32; } 0
                }
                pub unsafe fn RegSetValueExW(_: HKEY, _: *const u16, _: u32, kind: u32, data: *const u8, size: u32) -> u32 {
                    let mut r = REG.lock().unwrap();
                    if r.fail_write { return 5; }
                    r.value = Some((kind, unsafe { std::slice::from_raw_parts(data, size as usize) }.to_vec()));
                    r.changes += 1; 0
                }
                pub unsafe fn RegDeleteValueW(_: HKEY, _: *const u16) -> u32 {
                    let mut r = REG.lock().unwrap();
                    if r.fail_write { return 5; }
                    if r.value.take().is_none() { return 2; }
                    r.changes += 1; 0
                }
                pub unsafe fn RegCloseKey(_: HKEY) -> u32 { REG.lock().unwrap().closes += 1; 0 }
            }
            pub mod Environment {
                pub unsafe fn ExpandEnvironmentStringsW(input: *const u16, output: *mut u16, size: u32) -> u32 {
                    let mut len = 0;
                    while unsafe { *input.add(len) } != 0 { len += 1; }
                    let text = String::from_utf16(unsafe { std::slice::from_raw_parts(input, len) }).unwrap();
                    let text = text.replace("%SYNTHETIC_EXE%", std::env::current_exe().unwrap().to_str().unwrap());
                    let wide = crate::wide(&text);
                    if size >= wide.len() as u32 { unsafe { std::ptr::copy_nonoverlapping(wide.as_ptr(), output, wide.len()); } }
                    wide.len() as u32
                }
            }
        }
    }
}
${functions}
fn set_value(kind: u32, text: &str) {
    let mut r = REG.lock().unwrap();
    r.key = true;
    r.value = Some((kind, wide(text).iter().flat_map(|u| u.to_le_bytes()).collect()));
}
fn reset() { *REG.lock().unwrap() = Registry::default(); }
fn balanced() { let r = REG.lock().unwrap(); assert_eq!(r.opens, r.closes); }
fn main() {
    reset(); assert!(!autostart_status().unwrap().enabled);
    apply_autostart(false).unwrap(); assert!(!REG.lock().unwrap().key); balanced();
    println!("PASS missing key and global disable are read-only no-ops");
    REG.lock().unwrap().denied = true;
    assert!(autostart_status().is_err()); assert!(apply_autostart(true).is_err()); balanced();
    println!("PASS denied access is an error, never a disabled status");
    reset(); apply_autostart(true).unwrap();
    let status = autostart_status().unwrap();
    assert!(status.enabled && status.target_exists && status.target_is_current, "{status:?}");
    assert_eq!(status.target_path, Some(std::env::current_exe().unwrap().to_str().unwrap().into()));
    assert_eq!(REG.lock().unwrap().access, 1); balanced();
    println!("PASS enable creates the key, quotes the actual executable and reads with query-only access");
    let snapshot = REG.lock().unwrap().value.clone();
    for _ in 0..3 { autostart_status().unwrap(); }
    assert_eq!(REG.lock().unwrap().value, snapshot); balanced();
    println!("PASS status reads preserve the registered target");
    set_value(1, r#""Z:\missing\old-version.exe""#);
    let status = autostart_status().unwrap();
    assert!(status.enabled && !status.target_exists && !status.target_is_current);
    apply_autostart(false).unwrap(); assert!(!autostart_status().unwrap().enabled); balanced();
    println!("PASS missing old-version targets remain enabled and can be disabled globally");
    for (kind, value) in [(1, ""), (4, "anything"), (1, "relative.exe"), (1, "C:\\Program Files\\app.exe"), (1, "\"unterminated.exe"), (1, "x\0y")] {
        set_value(kind, value);
        let status = autostart_status().unwrap();
        assert!(status.enabled && status.target_path.is_none(), "invalid registration: {value:?}");
        balanced();
    }
    REG.lock().unwrap().value = Some((1, vec![1]));
    assert!(autostart_status().unwrap().target_path.is_none()); balanced();
    println!("PASS invalid registry strings remain visible and repairable");
    set_value(2, "\"%SYNTHETIC_EXE%\" --startup");
    let status = autostart_status().unwrap(); assert!(status.target_exists && status.target_is_current); balanced();
    println!("PASS expanded and quoted executable commands resolve their real target");
    REG.lock().unwrap().grow = 1;
    assert!(autostart_status().unwrap().target_is_current); balanced();
    REG.lock().unwrap().grow = 10;
    assert!(autostart_status().is_err()); balanced();
    println!("PASS registry resizing is retried with a bounded failure path");
    REG.lock().unwrap().grow = 0; REG.lock().unwrap().fail_write = true;
    let before = REG.lock().unwrap().value.clone();
    assert!(apply_autostart(false).is_err()); assert!(apply_autostart(true).is_err());
    assert_eq!(REG.lock().unwrap().value, before); balanced();
    println!("PASS failed enable and disable preserve the original registration and close handles");
}
`;
const out = path.join(root, '.build/autostart-probe');
await mkdir(out, { recursive: true });
await writeFile(path.join(out, 'probe.rs'), rust, 'utf8');
const exe = path.join(out, process.platform === 'win32' ? 'probe.exe' : 'probe');
execFileSync(rustc, ['--edition=2021', path.join(out, 'probe.rs'), '-o', exe],
  { cwd: root, timeout: 60000, windowsHide: true, stdio: 'pipe' });
const output = execFileSync(exe, [], { cwd: root, timeout: 15000, windowsHide: true, encoding: 'utf8' });
console.log(output.trim());
assert.equal(output.split('\n').filter((line) => line.startsWith('PASS ')).length, 9);
