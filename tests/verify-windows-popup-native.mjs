/*
 * Exact Tao native-window smoke probe. Uses only owned off-screen windows,
 * no WebView/profile, clipboard, selection, input injection or network.
 * It does not replace a real Tauri/WebView2 device acceptance test.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('This native probe requires Windows.');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.build/popup-native-probe');
const source = new TextDecoder('utf-8', { fatal: true })
  .decode(await readFile(path.join(root, 'desktop/patch/setup.rs'))).replace(/\r\n/g, '\n');
function productionFunction(name) {
  const start = source.indexOf(`fn ${name}(`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, `Production helper ${name} is present`);
  return source.slice(start, end + 2);
}
const functions = ['set_popup_capture_mode', 'show_popup_without_focus']
  .map(productionFunction).join('\n\n');
const rust = String.raw`
use std::sync::Arc;
use std::time::{Duration, Instant};
use tao::{dpi::{LogicalPosition, LogicalSize}, event::{Event, StartCause},
    event_loop::{ControlFlow, EventLoop}, platform::windows::WindowExtWindows,
    window::{Window, WindowBuilder}};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowLongPtrW, IsWindowVisible, ShowWindow,
    GWL_EXSTYLE, SW_HIDE, SW_SHOWNOACTIVATE, WS_EX_NOACTIVATE,
};
struct WebviewWindow(Arc<Window>);
impl WebviewWindow {
    fn set_focusable(&self, value: bool) -> Result<(), String> {
        self.0.set_focusable(value); Ok(())
    }
    fn show(&self) -> Result<(), String> { self.0.set_visible(true); Ok(()) }
}
${functions}
fn visible(window: &Window) -> bool { unsafe { IsWindowVisible(window.hwnd() as _) != 0 } }
fn noactivate(window: &Window) -> bool {
    unsafe { GetWindowLongPtrW(window.hwnd() as _, GWL_EXSTYLE) & WS_EX_NOACTIVATE as isize != 0 }
}
fn await_state(test: impl Fn() -> bool) {
    let start = Instant::now();
    while !test() {
        assert!(start.elapsed() < Duration::from_secs(2), "Native state update timed out");
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn build_window(event_loop: &EventLoop<()>, title: &str) -> Arc<Window> {
    Arc::new(WindowBuilder::new().with_title(title).with_visible(false)
        .with_focused(false).with_focusable(false).with_decorations(false)
        .with_inner_size(LogicalSize::new(32.0, 24.0))
        .with_position(LogicalPosition::new(-32000.0, -32000.0))
        .build(event_loop).expect("create owned native probe window"))
}
fn main() {
    let event_loop = EventLoop::new();
    let legacy = build_window(&event_loop, "Owned legacy popup probe");
    let popup = build_window(&event_loop, "Owned current popup probe");
    let completion = event_loop.create_proxy();
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        if matches!(event, Event::NewEvents(StartCause::Init)) {
            let legacy = Arc::clone(&legacy);
            let popup = Arc::clone(&popup);
            let completion = completion.clone();
            std::thread::spawn(move || {
                let foreground = unsafe { GetForegroundWindow() } as isize;
                unsafe { ShowWindow(legacy.hwnd() as _, SW_SHOWNOACTIVATE); }
                assert!(visible(&legacy));
                legacy.set_visible(false);
                std::thread::sleep(Duration::from_millis(100));
                assert!(visible(&legacy),
                    "Baseline must reproduce native-visible/framework-hidden mismatch");
                unsafe { ShowWindow(legacy.hwnd() as _, SW_HIDE); }
                println!("PASS raw ShowWindow baseline reproduces framework hide no-op");
                let adapter = WebviewWindow(Arc::clone(&popup));
                for _ in 0..12 {
                    set_popup_capture_mode(&adapter, true).unwrap();
                    await_state(|| noactivate(&popup));
                    show_popup_without_focus(&adapter).unwrap();
                    await_state(|| visible(&popup));
                    assert_eq!(unsafe { GetForegroundWindow() } as isize, foreground,
                        "Pending show must not activate an off-screen probe");
                    popup.set_visible(false);
                    await_state(|| !visible(&popup));
                    // Restore the completed style while hidden, without claiming
                    // actual foreground focus or interacting with the user's app.
                    set_popup_capture_mode(&adapter, false).unwrap();
                    await_state(|| !noactivate(&popup));
                }
                println!("PASS production show/capture helpers preserve native state over 12 hide/reopen cycles");
                println!("PASS pending probe never changes foreground or injects input");
                let _ = completion.send_event(());
            });
        } else if matches!(event, Event::UserEvent(())) {
            *flow = ControlFlow::Exit;
        }
    });
}
`;
await mkdir(path.join(output, 'src'), { recursive: true });
await writeFile(path.join(output, 'Cargo.toml'), `[package]\nname="popup-native-probe"\nversion="0.1.0"\nedition="2021"\npublish=false\n[dependencies]\ntao="=0.34.5"\nwindows-sys={version="0.61.2",features=["Win32_Foundation","Win32_UI_WindowsAndMessaging"]}\n`, 'utf8');
await writeFile(path.join(output, 'src/main.rs'), rust, 'utf8');
const environment = { ...process.env, CARGO_NET_OFFLINE: 'true',
  CARGO_TARGET_DIR: path.join(output, 'target') };
execFileSync('cargo', ['build', '--manifest-path', path.join(output, 'Cargo.toml'),
  '--target', 'x86_64-pc-windows-msvc', '--offline'],
{ cwd: root, env: environment, windowsHide: true, stdio: 'pipe', timeout: 120000 });
const executable = path.join(output, 'target/x86_64-pc-windows-msvc/debug/popup-native-probe.exe');
const text = execFileSync(executable, [], { cwd: root, env: environment,
  windowsHide: true, encoding: 'utf8', timeout: 15000 });
const checks = text.trim().split(/\r?\n/).filter((line) => line.startsWith('PASS '));
assert.equal(checks.length, 3);
console.log(text.trim());
await writeFile(path.join(root, '.build/popup-native-probe-result.json'), `${JSON.stringify({
  source: 'desktop/patch/setup.rs',
  nativeLibrary: 'tao 0.34.5',
  checks: checks.map((name) => ({ name: name.slice(5), passed: true })),
  passed: checks.length,
  scope: 'Native owned windows and exact production visibility/focusability helpers; no WebView construction, actual activation or user data tested.',
}, null, 2)}\n`, 'utf8');
