/*
 * Runs the production Windows popup orchestration against synthetic Win32 and
 * Tauri boundaries. The only child processes are rustc and this generated
 * fixture; no application, selection, clipboard, preferences or network is used.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const rustc = process.platform === 'win32' && process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, '.cargo', 'bin', 'rustc.exe') : 'rustc';
const source = new TextDecoder('utf-8', { fatal: true })
  .decode(await readFile(path.join(root, 'desktop/patch/setup.rs'))).replace(/\r\n/g, '\n');
function productionFunction(name) {
  const start = source.indexOf(`fn ${name}(`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, `Production function ${name} is present`);
  return source.slice(start, end + 2);
}
const functions = [
  'popup_request_is_current', 'next_popup_generation', 'cancel_popup_request',
  'set_popup_capture_mode', 'popup_extended_style', 'show_popup_without_focus',
  'complete_popup', 'present_popup', 'run_selection_translate',
].map(productionFunction).join('\n\n');
const watcherFunctions = [
  'popup_request_is_current', 'next_popup_generation', 'cancel_popup_request',
  'dismiss_popup_if_current', 'watch_popup',
].map(productionFunction).join('\n\n');

const fixture = String.raw`
#![allow(non_snake_case, non_upper_case_globals, dead_code)]
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const POPUP_LABEL: &str = "popup";
const APP_WINDOW_LABEL: &str = "main";
static POPUP_SEQ: AtomicU64 = AtomicU64::new(0);
static POPUP_GENERATION: AtomicU64 = AtomicU64::new(0);
static ACTIVE: Mutex<Option<Arc<World>>> = Mutex::new(None);
static LAST_ERROR: AtomicU32 = AtomicU32::new(0);

struct World {
    data: Mutex<Data>,
    release: Condvar,
}
struct Data {
    events: Vec<String>,
    visible: bool,
    created: bool,
    capture_released: bool,
    text: String,
    main: bool,
    style: isize,
    cached_style: isize,
    fail_refresh: bool,
    fail_style: bool,
}
impl World {
    fn new(main: bool, text: &str) -> Arc<Self> {
        let world = Arc::new(Self {
            data: Mutex::new(Data { events: vec![], visible: false, created: false,
                capture_released: false, text: text.into(), main, style: 0x80,
                cached_style: 0x80, fail_refresh: false, fail_style: false }),
            release: Condvar::new(),
        });
        *ACTIVE.lock().unwrap() = Some(world.clone());
        POPUP_GENERATION.store(0, Ordering::Release);
        POPUP_SEQ.store(0, Ordering::Release);
        world
    }
    fn events(&self) -> Vec<String> { self.data.lock().unwrap().events.clone() }
    fn log(&self, event: impl Into<String>) { self.data.lock().unwrap().events.push(event.into()); }
    fn release_capture(&self) {
        self.data.lock().unwrap().capture_released = true;
        self.release.notify_all();
    }
    fn wait(&self, event: &str) {
        let started = Instant::now();
        while !self.events().iter().any(|value| value == event) {
            assert!(started.elapsed() < Duration::from_secs(3), "Missing event {event}: {:?}", self.events());
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}
fn world() -> Arc<World> { ACTIVE.lock().unwrap().as_ref().unwrap().clone() }
#[derive(Clone)]
struct AppHandle;
#[derive(Clone)]
struct WebviewWindow;
struct Hwnd(*mut std::ffi::c_void);
impl AppHandle {
    fn run_on_main_thread(&self, task: impl FnOnce() + Send + 'static) -> Result<(), String> {
        task();
        Ok(())
    }
    fn get_webview_window(&self, label: &str) -> Option<WebviewWindow> {
        let state = world();
        let exists = state.data.lock().unwrap().created;
        if label == POPUP_LABEL && exists { Some(WebviewWindow) } else { None }
    }
}
impl WebviewWindow {
    fn hwnd(&self) -> Result<Hwnd, String> { Ok(Hwnd(std::ptr::dangling_mut())) }
    fn is_visible(&self) -> Result<bool, String> { Ok(world().data.lock().unwrap().visible) }
    fn eval(&self, script: &str) -> Result<(), String> {
        if script.contains("__popupPresent") { world().log("present-animation"); }
        Ok(())
    }
    fn set_focus(&self) -> Result<(), String> {
        let state = world();
        let mut data = state.data.lock().unwrap();
        assert_eq!(data.cached_style & windows_sys::Win32::UI::WindowsAndMessaging::WS_EX_NOACTIVATE as isize, 0,
            "Focus cannot precede the native style-cache refresh");
        data.events.push("focus".into());
        Ok(())
    }
}
struct Settings { open_main_window: bool, target_lang: String }
fn current_settings() -> Settings {
    Settings { open_main_window: world().data.lock().unwrap().main, target_lang: "auto".into() }
}
fn popup_appearance(_: &Settings) {}
fn popup_payload(id: u64, phase: &str, _: &str, _: &str, _: &str) -> String {
    format!("payload:{id}:{phase}")
}
fn deliver_popup(_: &WebviewWindow, payload: &str, _: &()) { world().log(payload); }
fn ensure_popup(_: &AppHandle) -> Option<WebviewWindow> {
    let state = world();
    let mut data = state.data.lock().unwrap();
    if !data.created { data.events.push("create".into()); data.created = true; }
    Some(WebviewWindow)
}
fn position_popup(_: &AppHandle, _: &WebviewWindow) { world().log("position"); }
fn retry_popup_delivery(_: &WebviewWindow, _: &str, _: u64) { world().log("retry-scheduled"); }
fn watch_popup(_: AppHandle, _: WebviewWindow, _: u64) { world().log("watch"); }
fn popup_is_foreground(_: &AppHandle) -> bool { false }
fn hide_popup(_: &AppHandle) { world().log("hide"); world().data.lock().unwrap().visible = false; }
fn cancel_startup_reveal(_: &Arc<AtomicBool>) { world().log("cancel-startup"); }
fn show_all_app_windows(_: &AppHandle, _: bool) { world().log("show-main"); }
fn capture_selection(_: u64) -> String {
    let state = world();
    state.log("capture-start");
    let mut data = state.data.lock().unwrap();
    while !data.capture_released { data = state.release.wait(data).unwrap(); }
    data.events.push("capture-finished".into());
    data.text.clone()
}
mod serde_json {
    pub fn to_string(value: &str) -> Result<String, String> { Ok(format!("{value:?}")) }
}
mod windows_sys {
    pub mod Win32 {
        pub mod Foundation {
            pub unsafe fn SetLastError(error: u32) { crate::LAST_ERROR.store(error, crate::Ordering::Release); }
            pub unsafe fn GetLastError() -> u32 { crate::LAST_ERROR.load(crate::Ordering::Acquire) }
        }
        pub mod UI {
            pub mod WindowsAndMessaging {
                use std::ffi::c_void;
                pub const GWL_EXSTYLE: i32 = -20;
                pub const WS_EX_NOACTIVATE: u32 = 0x08000000;
                pub const SWP_FRAMECHANGED: u32 = 0x20;
                pub const SWP_NOMOVE: u32 = 2;
                pub const SWP_NOSIZE: u32 = 1;
                pub const SWP_NOZORDER: u32 = 4;
                pub const SWP_NOOWNERZORDER: u32 = 0x200;
                pub const SWP_NOACTIVATE: u32 = 0x10;
                pub const SW_SHOWNOACTIVATE: i32 = 4;
                pub unsafe fn GetWindowLongPtrW(_: *mut c_void, _: i32) -> isize {
                    crate::world().data.lock().unwrap().style
                }
                pub unsafe fn SetWindowLongPtrW(_: *mut c_void, _: i32, style: isize) -> isize {
                    let state = crate::world();
                    let mut data = state.data.lock().unwrap();
                    if data.fail_style {
                        crate::LAST_ERROR.store(5, crate::Ordering::Release);
                        return 0;
                    }
                    let previous = data.style;
                    data.style = style;
                    data.events.push(if style & WS_EX_NOACTIVATE as isize != 0 { "style-pending" } else { "style-ready" }.into());
                    previous
                }
                pub unsafe fn SetWindowPos(_: *mut c_void, _: *mut c_void, x: i32, y: i32, width: i32, height: i32, flags: u32) -> i32 {
                    assert_eq!([x, y, width, height], [0, 0, 0, 0]);
                    assert_eq!(flags, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_NOACTIVATE,
                        "The refresh must preserve geometry, Z order and activation");
                    let state = crate::world();
                    let mut data = state.data.lock().unwrap();
                    if data.fail_refresh {
                        crate::LAST_ERROR.store(5, crate::Ordering::Release);
                        data.events.push("refresh-failed".into());
                        return 0;
                    }
                    data.cached_style = data.style;
                    let pending = data.style & WS_EX_NOACTIVATE as isize != 0;
                    data.events.push(if pending { "refresh-pending" } else { "refresh-ready" }.into());
                    1
                }
                pub unsafe fn ShowWindow(_: *mut c_void, command: i32) -> i32 {
                    assert_eq!(command, SW_SHOWNOACTIVATE);
                    let state = crate::world();
                    let mut data = state.data.lock().unwrap();
                    data.visible = true;
                    data.events.push("show-inactive".into());
                    1
                }
            }
        }
    }
}

${functions}

fn before(events: &[String], left: &str, right: &str) {
    let a = events.iter().position(|event| event == left).expect(left);
    let b = events.iter().position(|event| event == right).expect(right);
    assert!(a < b, "{left} must precede {right}: {events:?}");
}
fn check(name: &str) { println!("PASS {name}"); }
fn start() { run_selection_translate(AppHandle, false, Arc::new(AtomicBool::new(false))); }
fn main() {
    let state = World::new(false, "Synthetic selection");
    start();
    state.wait("capture-start");
    let pending = state.events();
    before(&pending, "refresh-pending", "show-inactive");
    before(&pending, "payload:1:pending", "show-inactive");
    before(&pending, "show-inactive", "capture-start");
    before(&pending, "present-animation", "capture-start");
    assert!(!pending.iter().any(|event| event == "focus" || event == "payload:1:ready"));
    check("Pending is presented with its arrival before capture and never focuses the source away");
    state.release_capture();
    state.wait("focus");
    let ready = state.events();
    before(&ready, "capture-finished", "payload:1:ready");
    before(&ready, "refresh-ready", "focus");
    assert_eq!(ready.iter().filter(|event| event.as_str() == "create").count(), 1);
    assert_eq!(ready.iter().filter(|event| event.as_str() == "show-inactive").count(), 1);
    assert_eq!(ready.iter().filter(|event| event.as_str() == "present-animation").count(), 1);
    check("Ready updates the existing popup once and refreshes native activation before focusing");

    let state = World::new(false, "Late selection");
    start();
    state.wait("capture-start");
    let generation = POPUP_GENERATION.load(Ordering::Acquire);
    cancel_popup_request(generation);
    state.data.lock().unwrap().visible = false;
    state.release_capture();
    state.wait("capture-finished");
    std::thread::sleep(Duration::from_millis(10));
    assert!(!state.events().iter().any(|event| event == "payload:1:ready" || event == "focus"));
    check("Closing pending capture prevents late delivery and reopening");

    let state = World::new(false, "Obsolete selection");
    start();
    state.wait("capture-start");
    next_popup_generation();
    state.release_capture();
    state.wait("capture-finished");
    std::thread::sleep(Duration::from_millis(10));
    assert!(!state.events().iter().any(|event| event == "payload:1:ready" || event == "focus"));
    check("A newer generation rejects old captured text");
    let before_count = state.events().len();
    complete_popup(&AppHandle, 1, 1, "Old", "", "auto");
    assert_eq!(state.events().len(), before_count);
    check("An obsolete completion cannot touch a newer popup");

    let state = World::new(true, "");
    start();
    state.wait("capture-start");
    assert!(!state.events().iter().any(|event| event == "create"));
    state.release_capture();
    state.wait("focus");
    let notice = state.events();
    before(&notice, "capture-finished", "payload:1:pending");
    before(&notice, "show-inactive", "payload:1:notice");
    assert!(!notice.iter().any(|event| event == "show-main"));
    check("An empty main-window selection still displays its existing notice destination");

    let state = World::new(false, "Text after a failed refresh");
    state.data.lock().unwrap().created = true;
    state.data.lock().unwrap().visible = true;
    set_popup_capture_mode(&WebviewWindow, true).unwrap();
    state.data.lock().unwrap().fail_refresh = true;
    let generation = next_popup_generation();
    complete_popup(&AppHandle, 1, generation, "Synthetic translation", "", "auto");
    let failed = state.events();
    assert!(failed.iter().any(|event| event == "refresh-failed"));
    assert!(failed.iter().any(|event| event == "payload:1:ready"));
    assert!(!failed.iter().any(|event| event == "focus"));
    check("A failed style refresh still delivers text and does not claim focus readiness");
    state.data.lock().unwrap().fail_refresh = false;
    set_popup_capture_mode(&WebviewWindow, false).unwrap();
    assert_eq!(state.events().last().unwrap(), "refresh-ready");
    check("Retry refreshes the native cache even when the style bit already has its desired value");
    state.data.lock().unwrap().fail_style = true;
    assert!(set_popup_capture_mode(&WebviewWindow, true).is_err());
    check("A failed native style write is reported");
}
`;

const output = path.join(root, '.build/windows-popup-contract');
await mkdir(output, { recursive: true });
const rustSource = path.join(output, 'popup_lifecycle.rs');
const executable = path.join(output, process.platform === 'win32' ? 'popup_lifecycle.exe' : 'popup_lifecycle');
await writeFile(rustSource, fixture, 'utf8');
execFileSync(rustc, ['--edition=2021', rustSource, '-o', executable], { stdio: 'pipe' });
let text = execFileSync(executable, [], { encoding: 'utf8' });
const watcherFixture = String.raw`
#![allow(non_snake_case, dead_code)]
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
static POPUP_GENERATION: AtomicU64 = AtomicU64::new(0);
static FOREGROUND_READS: AtomicUsize = AtomicUsize::new(0);
static EVENTS: Mutex<Vec<String>> = Mutex::new(vec![]);
static UI_QUEUE: Mutex<Vec<Box<dyn FnOnce() + Send>>> = Mutex::new(vec![]);
fn log(event: &str) { EVENTS.lock().unwrap().push(event.into()); }
fn wait(event: &str) {
    let start = Instant::now();
    while !EVENTS.lock().unwrap().iter().any(|value| value == event) {
        assert!(start.elapsed() < Duration::from_secs(3), "Missing event {event}");
        std::thread::sleep(Duration::from_millis(1));
    }
}
#[derive(Clone)]
struct AppHandle;
#[derive(Clone)]
struct WebviewWindow;
struct Hwnd(*mut std::ffi::c_void);
impl AppHandle {
    fn run_on_main_thread(&self, task: impl FnOnce() + Send + 'static) -> Result<(), String> {
        UI_QUEUE.lock().unwrap().push(Box::new(task));
        log("close-queued");
        Ok(())
    }
}
impl WebviewWindow {
    fn hwnd(&self) -> Result<Hwnd, String> { Ok(Hwnd(std::ptr::dangling_mut())) }
    fn is_visible(&self) -> Result<bool, String> { Ok(true) }
    fn eval(&self, script: &str) -> Result<(), String> {
        assert!(script.contains("__popupDismiss"));
        log("dismiss");
        Ok(())
    }
    fn destroy(&self) -> Result<(), String> { log("destroy"); Ok(()) }
}
mod windows_sys {
    pub mod Win32 {
        pub mod UI {
            pub mod Input {
                pub mod KeyboardAndMouse {
                    pub unsafe fn GetAsyncKeyState(_: i32) -> i16 { 0 }
                }
            }
            pub mod WindowsAndMessaging {
                pub unsafe fn GetForegroundWindow() -> *mut std::ffi::c_void {
                    let read = crate::FOREGROUND_READS.fetch_add(1, crate::Ordering::AcqRel);
                    if read == 0 {
                        crate::log("foreground-seen");
                        std::ptr::dangling_mut()
                    } else {
                        if read == 1 { crate::log("blur-confirmation-started"); }
                        std::ptr::null_mut()
                    }
                }
            }
        }
    }
}
${watcherFunctions}
fn main() {
    let old = next_popup_generation();
    watch_popup(AppHandle, WebviewWindow, old);
    wait("foreground-seen");
    wait("blur-confirmation-started");
    let current = next_popup_generation();
    std::thread::sleep(Duration::from_millis(300));
    assert!(popup_request_is_current(current));
    assert!(UI_QUEUE.lock().unwrap().is_empty(),
        "An old watcher must exit after its 120ms confirmation sleep");
    assert!(!EVENTS.lock().unwrap().iter().any(|event| event == "dismiss" || event == "destroy"));
    println!("PASS A new shortcut during the real watcher blur-confirmation sleep keeps its reused popup");

    dismiss_popup_if_current(&AppHandle, &WebviewWindow, current);
    assert_eq!(UI_QUEUE.lock().unwrap().len(), 1);
    let newer = next_popup_generation();
    let task = UI_QUEUE.lock().unwrap().remove(0);
    task();
    assert!(popup_request_is_current(newer));
    assert!(!EVENTS.lock().unwrap().iter().any(|event| event == "dismiss" || event == "destroy"));
    println!("PASS A queued old close rechecks request ownership on the UI thread");

    dismiss_popup_if_current(&AppHandle, &WebviewWindow, newer);
    let task = UI_QUEUE.lock().unwrap().remove(0);
    task();
    assert!(!popup_request_is_current(newer));
    let events = EVENTS.lock().unwrap();
    let dismiss = events.iter().position(|event| event == "dismiss").unwrap();
    let destroy = events.iter().position(|event| event == "destroy").unwrap();
    assert!(dismiss < destroy);
    println!("PASS The current request is invalidated and dismissed before its native window closes");
}
`;
const watcherSource = path.join(output, 'popup_watchdog.rs');
const watcherExecutable = path.join(output, process.platform === 'win32' ? 'popup_watchdog.exe' : 'popup_watchdog');
await writeFile(watcherSource, watcherFixture, 'utf8');
execFileSync(rustc, ['--edition=2021', watcherSource, '-o', watcherExecutable], { stdio: 'pipe' });
text += execFileSync(watcherExecutable, [], { encoding: 'utf8' });
console.log(text.trim());
const checks = text.trim().split(/\r?\n/).filter((line) => line.startsWith('PASS '));
await writeFile(path.join(root, '.build/windows-popup-lifecycle.json'), `${JSON.stringify({
  source: 'desktop/patch/setup.rs',
  synthetic: true,
  checks: checks.map((name) => ({ name: name.slice(5), passed: true })),
  passed: checks.length,
}, null, 2)}\n`, 'utf8');
