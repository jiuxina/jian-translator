/*
 * Exercises the production frame/corner callbacks with owned, hidden Tao
 * windows. No existing windows, WebViews, clipboard, profiles or input are read.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('This native probe requires Windows.');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.build/window-frame-probe');
const source = new TextDecoder('utf-8', { fatal: true })
  .decode(await readFile(path.join(root, 'desktop/patch/setup.rs'))).replace(/\r\n/g, '\n');
function productionFunction(name) {
  const start = source.indexOf(`fn ${name}(`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, `Production helper ${name} is present`);
  const prefix = name === 'remove_top_frame_inset' ? 'unsafe extern "system" ' : '';
  return prefix + source.slice(start, end + 2);
}
const functions = ['update_main_window_corners', 'apply_window_border',
  'remove_top_frame_inset', 'remove_main_window_top_frame_inset'].map(productionFunction).join('\n\n');
const rust = String.raw`
use std::sync::Arc;
use tao::{dpi::{LogicalPosition, LogicalSize}, event::{Event, StartCause},
    event_loop::{ControlFlow, EventLoop},
    platform::windows::{WindowBuilderExtWindows, WindowExtWindows},
    window::{Window, WindowBuilder}};
use windows_sys::Win32::{Foundation::{HWND, POINT, RECT},
    Graphics::Gdi::{ClientToScreen, CreateRectRgn, DeleteObject, GetWindowRgn, PtInRegion},
    UI::WindowsAndMessaging::{GetClientRect, GetWindowRect, IsWindowVisible, SetWindowPos,
        SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER}};
struct NativeHandle(HWND);
struct WebviewWindow(Arc<Window>);
impl WebviewWindow {
    fn hwnd(&self) -> Result<NativeHandle, String> { Ok(NativeHandle(self.0.hwnd() as _)) }
}
${functions}
fn bounds(hwnd: HWND) -> (RECT, RECT, POINT) {
    let mut outer = RECT::default();
    let mut client = RECT::default();
    let mut origin = POINT::default();
    unsafe {
        assert_ne!(GetWindowRect(hwnd, &mut outer), 0);
        assert_ne!(GetClientRect(hwnd, &mut client), 0);
        assert_ne!(ClientToScreen(hwnd, &mut origin), 0);
    }
    (outer, client, origin)
}
fn assert_edge_to_edge(window: &Window) {
    let (outer, client, origin) = bounds(window.hwnd() as _);
    assert_eq!((origin.x, origin.y), (outer.left, outer.top),
        "The rendered client must start at the outer edge; residual native inset produces white borders");
    assert_eq!((client.right, client.bottom),
        (outer.right - outer.left, outer.bottom - outer.top),
        "The rendered client must cover the right and bottom native frame");
}
fn main() {
    let event_loop = EventLoop::new();
    let window = Arc::new(WindowBuilder::new().with_title("Owned frame probe")
        .with_visible(false).with_focused(false).with_focusable(false)
        .with_decorations(false).with_undecorated_shadow(true)
        .with_inner_size(LogicalSize::new(640.0, 480.0))
        .with_position(LogicalPosition::new(-32000.0, -32000.0))
        .build(&event_loop).expect("create owned hidden window"));
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        if matches!(event, Event::NewEvents(StartCause::Init)) {
            let hwnd = window.hwnd() as HWND;
            let (outer, client, _) = bounds(hwnd);
            assert!(client.right < outer.right - outer.left,
                "Baseline must reproduce Tao's hidden shadow frame inset");
            println!("PASS baseline reproduces the native shadow frame outside the client");
            let adapter = WebviewWindow(Arc::clone(&window));
            remove_main_window_top_frame_inset(&adapter);
            apply_window_border(&adapter);
            assert_edge_to_edge(&window);
            println!("PASS production subclass expands the client across all four edges immediately");
            for (width, height) in [(800, 600), (1000, 720), (400, 300)] {
                unsafe { assert_ne!(SetWindowPos(hwnd, std::ptr::null_mut(), 0, 0, width, height,
                    SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOZORDER | SWP_FRAMECHANGED), 0); }
                assert_edge_to_edge(&window);
                apply_window_border(&adapter);
                assert_edge_to_edge(&window);
            }
            println!("PASS resize and border reapplication keep the entire client covered");
            unsafe {
                let region = CreateRectRgn(0, 0, 0, 0);
                assert_ne!(GetWindowRgn(hwnd, region), 0, "Normal window retains custom rounding");
                assert_eq!(PtInRegion(region, 0, 0), 0, "Rounded corner stays clipped");
                assert_ne!(PtInRegion(region, 200, 150), 0, "Window centre remains visible");
                assert_ne!(DeleteObject(region), 0);
                assert_eq!(IsWindowVisible(hwnd), 0, "Probe must remain hidden");
            }
            println!("PASS rounded region is retained and the owned probe never becomes visible");
            *flow = ControlFlow::Exit;
        }
    });
}
`;
await mkdir(path.join(output, 'src'), { recursive: true });
await writeFile(path.join(output, 'Cargo.toml'), `[package]
name="window-frame-probe"
version="0.1.0"
edition="2021"
publish=false
[dependencies]
tao="=0.34.5"
windows-sys={version="0.61.2",features=["Win32_Foundation","Win32_Graphics_Dwm","Win32_Graphics_Gdi","Win32_UI_Controls","Win32_UI_HiDpi","Win32_UI_Shell","Win32_UI_WindowsAndMessaging"]}
`, 'utf8');
await writeFile(path.join(output, 'src/main.rs'), rust, 'utf8');
const environment = { ...process.env, CARGO_NET_OFFLINE: 'true',
  CARGO_TARGET_DIR: path.join(root, '.build/popup-native-probe/target') };
execFileSync('cargo', ['build', '--manifest-path', path.join(output, 'Cargo.toml'),
  '--target', 'x86_64-pc-windows-msvc', '--offline'],
{ cwd: root, env: environment, windowsHide: true, stdio: 'pipe', timeout: 120000 });
const executable = path.join(environment.CARGO_TARGET_DIR,
  'x86_64-pc-windows-msvc/debug/window-frame-probe.exe');
const text = execFileSync(executable, [], { cwd: root, env: environment,
  windowsHide: true, encoding: 'utf8', timeout: 15000 });
const checks = text.trim().split(/\r?\n/).filter((line) => line.startsWith('PASS '));
assert.equal(checks.length, 4);
console.log(text.trim());
await writeFile(path.join(root, '.build/window-frame-probe-result.json'), `${JSON.stringify({
  source: 'desktop/patch/setup.rs', nativeLibrary: 'tao 0.34.5',
  checks: checks.map((name) => ({ name: name.slice(5), passed: true })),
  passed: checks.length,
  scope: 'Owned hidden native windows and exact production frame/corner callbacks; no WebView or real user data.',
}, null, 2)}\n`, 'utf8');
