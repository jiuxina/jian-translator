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
const ensureSource = productionFunction('ensure_popup');
assert.match(ensureSource, /CloseRequested\s*\{\s*api,\s*\.\.\s*\}[\s\S]*?api\.prevent_close\(\)/,
  'A native close request must not synchronously destroy the reusable WebView');
assert.match(ensureSource, /dismiss_popup_if_current\(&popup_handle,\s*&popup,\s*generation\)/,
  'A native close request must use the same generation-safe hide path as Escape');
const functions = [
  'popup_request_is_current', 'next_popup_generation', 'cancel_popup_request',
  'set_popup_capture_mode', 'show_popup_without_focus',
  'complete_popup', 'present_popup', 'run_selection_translate', 'dismiss_popup_if_current',
].map(productionFunction).join('\n\n');
const watcherFunctions = [
  'popup_request_is_current', 'next_popup_generation', 'cancel_popup_request',
  'popup_pointer_buttons', 'popup_pointer_pressed_outside',
  'dismiss_popup_if_current', 'watch_popup',
].map(productionFunction).join('\n\n');

const fixture = String.raw`
#![allow(non_snake_case, non_upper_case_globals, dead_code)]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const POPUP_LABEL: &str = "popup";
const APP_WINDOW_LABEL: &str = "main";
static POPUP_SEQ: AtomicU64 = AtomicU64::new(0);
static POPUP_GENERATION: AtomicU64 = AtomicU64::new(0);
static ACTIVE: Mutex<Option<Arc<World>>> = Mutex::new(None);

struct World {
    data: Mutex<Data>,
    release: Condvar,
    event_thread: std::thread::ThreadId,
}
struct Data {
    events: Vec<String>,
    visible: bool,
    framework_visible: bool,
    focusable: bool,
    created: bool,
    capture_released: bool,
    text: String,
    main: bool,
    fail_focusable: bool,
    fail_show: bool,
}
impl World {
    fn new(main: bool, text: &str) -> Arc<Self> {
        let world = Arc::new(Self {
            data: Mutex::new(Data { events: vec![], visible: false, framework_visible: false,
                focusable: true, created: false,
                capture_released: false, text: text.into(), main,
                fail_focusable: false, fail_show: false }),
            release: Condvar::new(),
            event_thread: std::thread::current().id(),
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
        self.wait_count(event, 1);
    }
    fn wait_count(&self, event: &str, count: usize) {
        let started = Instant::now();
        while self.events().iter().filter(|value| value.as_str() == event).count() < count {
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
        if script.contains("__popupDismiss") { world().log("dismiss"); }
        Ok(())
    }
    fn set_focusable(&self, focusable: bool) -> Result<(), String> {
        let state = world();
        let mut data = state.data.lock().unwrap();
        if data.fail_focusable {
            data.events.push("focusable-failed".into());
            return Err("Synthetic focusability failure".into());
        }
        if !focusable {
            assert!(!data.visible,
                "A still-visible result must be hidden before disabling activation and showing its next request");
        }
        data.focusable = focusable;
        data.events.push(if focusable { "focusable-ready" } else { "focusable-pending" }.into());
        Ok(())
    }
    fn show(&self) -> Result<(), String> {
        let state = world();
        let mut data = state.data.lock().unwrap();
        if data.fail_show {
            data.events.push("show-failed".into());
            return Err("Synthetic show failure".into());
        }
        assert!(!data.focusable, "The source application must retain focus before copy");
        data.visible = true;
        data.framework_visible = true;
        data.events.push("show-inactive".into());
        Ok(())
    }
    fn hide(&self) -> Result<(), String> {
        let state = world();
        let mut data = state.data.lock().unwrap();
        data.visible = false;
        data.framework_visible = false;
        data.events.push("hide".into());
        Ok(())
    }
    fn destroy(&self) -> Result<(), String> {
        world().log("destroy");
        world().data.lock().unwrap().created = false;
        Ok(())
    }
    fn set_focus(&self) -> Result<(), String> {
        let state = world();
        let mut data = state.data.lock().unwrap();
        if !data.framework_visible || !data.focusable {
            data.events.push("framework-focus-skipped".into());
            return Ok(());
        }
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
    if !data.created {
        assert_ne!(std::thread::current().id(), state.event_thread,
            "A cold WebView must never be built synchronously in its UI event handler");
        data.events.push("create".into());
        data.created = true;
    }
    Some(WebviewWindow)
}
fn position_popup(_: &AppHandle, _: &WebviewWindow) { world().log("position"); }
fn retry_popup_delivery(_: &WebviewWindow, _: &str, _: u64) { world().log("retry-scheduled"); }
fn watch_popup(_: AppHandle, _: WebviewWindow, _: u64) { world().log("watch"); }
fn popup_is_foreground(_: &AppHandle) -> bool { false }
fn hide_popup(_: &AppHandle) { WebviewWindow.hide().unwrap(); }
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
    before(&pending, "focusable-pending", "show-inactive");
    before(&pending, "payload:1:pending", "show-inactive");
    before(&pending, "show-inactive", "capture-start");
    before(&pending, "present-animation", "capture-start");
    assert!(!pending.iter().any(|event| event == "focus" || event == "payload:1:ready"));
    check("Pending is presented with its arrival before capture and never focuses the source away");
    state.release_capture();
    state.wait("focus");
    let ready = state.events();
    before(&ready, "capture-finished", "payload:1:ready");
    before(&ready, "focusable-ready", "focus");
    assert_eq!(ready.iter().filter(|event| event.as_str() == "create").count(), 1);
    assert_eq!(ready.iter().filter(|event| event.as_str() == "show-inactive").count(), 1);
    assert_eq!(ready.iter().filter(|event| event.as_str() == "present-animation").count(), 1);
    check("The first result updates the same popup and restores framework-visible focusability before focusing");
    for round in 2..=12 {
        let generation = POPUP_GENERATION.load(Ordering::Acquire);
        dismiss_popup_if_current(&AppHandle, &WebviewWindow, generation);
        assert!(!state.data.lock().unwrap().visible);
        assert!(state.data.lock().unwrap().created);
        assert!(!state.events().iter().any(|event| event == "destroy"));
        {
            let mut data = state.data.lock().unwrap();
            data.capture_released = false;
            data.text = format!("Synthetic selection {round}");
        }
        start();
        state.wait_count("capture-start", round);
        state.release_capture();
        state.wait_count("focus", round);
        assert_eq!(state.events().iter().filter(|event| event.as_str() == "create").count(), 1);
    }
    check("Twelve close and shortcut cycles reuse one live WebView and continue capture and translation");

    let quick_start = state.events().len();
    {
        let mut data = state.data.lock().unwrap();
        assert!(data.visible && data.framework_visible && data.focusable,
            "The previous result must still be visible before its watcher reacts");
        data.capture_released = false;
        data.text = "Quick source selection".into();
    }
    // The source application is foreground again, but the old popup has not
    // reached its 160ms watcher tick. Do not dismiss it before this shortcut.
    start();
    state.wait_count("capture-start", 13);
    let quick_pending = state.events()[quick_start..].to_vec();
    before(&quick_pending, "hide", "focusable-pending");
    before(&quick_pending, "focusable-pending", "show-inactive");
    before(&quick_pending, "show-inactive", "capture-start");
    assert!(!quick_pending.iter().any(|event| event == "focus" || event == "destroy"));
    assert_eq!(state.events().iter().filter(|event| event.as_str() == "create").count(), 1);
    state.release_capture();
    state.wait_count("focus", 13);
    check("A quick shortcut hides the still-visible prior result before nonactivating reuse and preserves source focus");

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

    let state = World::new(false, "Text after a failed focusability change");
    state.data.lock().unwrap().created = true;
    set_popup_capture_mode(&WebviewWindow, true).unwrap();
    state.data.lock().unwrap().visible = true;
    state.data.lock().unwrap().framework_visible = true;
    state.data.lock().unwrap().fail_focusable = true;
    let generation = next_popup_generation();
    complete_popup(&AppHandle, 1, generation, "Synthetic translation", "", "auto");
    let failed = state.events();
    assert!(failed.iter().any(|event| event == "focusable-failed"));
    assert!(failed.iter().any(|event| event == "payload:1:ready"));
    assert!(!failed.iter().any(|event| event == "focus"));
    check("A failed focusability update still delivers text without falsely claiming focus readiness");
    state.data.lock().unwrap().fail_focusable = false;
    set_popup_capture_mode(&WebviewWindow, false).unwrap();
    assert_eq!(state.events().last().unwrap(), "focusable-ready");
    check("Retry can restore focusability after a framework operation failure");
    state.data.lock().unwrap().fail_focusable = true;
    assert!(set_popup_capture_mode(&WebviewWindow, true).is_err());
    check("A failed framework focusability change is reported");

    let state = World::new(false, "No capture after show failure");
    state.data.lock().unwrap().fail_show = true;
    start();
    state.wait("show-failed");
    std::thread::sleep(Duration::from_millis(20));
    assert!(!state.events().iter().any(|event| event == "capture-start"));
    assert!(!state.data.lock().unwrap().visible);
    check("A failed pending show does not copy selection or leave a falsely visible popup");
}
`;

const output = path.join(root, '.build/windows-popup-contract');
await mkdir(output, { recursive: true });
const rustSource = path.join(output, 'popup_lifecycle.rs');
const executable = path.join(output, process.platform === 'win32' ? 'popup_lifecycle.exe' : 'popup_lifecycle');
await writeFile(rustSource, fixture, 'utf8');
let text = '';
const watcherFixture = String.raw`
#![allow(non_snake_case, dead_code)]
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
static POPUP_GENERATION: AtomicU64 = AtomicU64::new(0);
static FOREGROUND_READS: AtomicUsize = AtomicUsize::new(0);
static OUTSIDE_CLICK: AtomicUsize = AtomicUsize::new(0);
static POINTER_INSIDE: AtomicBool = AtomicBool::new(false);
static ESCAPE: AtomicBool = AtomicBool::new(false);
static VISIBLE: AtomicBool = AtomicBool::new(true);
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
    fn is_visible(&self) -> Result<bool, String> { Ok(VISIBLE.load(Ordering::Acquire)) }
    fn eval(&self, script: &str) -> Result<(), String> {
        assert!(script.contains("__popupDismiss"));
        log("dismiss");
        Ok(())
    }
    fn hide(&self) -> Result<(), String> {
        VISIBLE.store(false, Ordering::Release);
        log("hide");
        Ok(())
    }
    fn destroy(&self) -> Result<(), String> { log("destroy"); Ok(()) }
}
mod windows_sys {
    pub mod Win32 {
        pub mod Foundation {
            #[derive(Default)]
            pub struct POINT { pub x: i32, pub y: i32 }
            #[derive(Default)]
            pub struct RECT { pub left: i32, pub top: i32, pub right: i32, pub bottom: i32 }
        }
        pub mod UI {
            pub mod Input {
                pub mod KeyboardAndMouse {
                    pub const VK_LBUTTON: u16 = 1;
                    pub const VK_RBUTTON: u16 = 2;
                    pub const VK_MBUTTON: u16 = 4;
                    pub const VK_XBUTTON1: u16 = 5;
                    pub const VK_XBUTTON2: u16 = 6;
                    pub unsafe fn GetAsyncKeyState(key: i32) -> i16 {
                        if key == 1 && crate::OUTSIDE_CLICK.load(crate::Ordering::Acquire) != 0 {
                            0x8001u16 as i16
                        } else if key == 0x1B && crate::ESCAPE.swap(false, crate::Ordering::AcqRel) {
                            0x8001u16 as i16
                        } else { 0 }
                    }
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
                        if read == 100 { crate::log("nonforeground-poll"); }
                        std::ptr::null_mut()
                    }
                }
                pub unsafe fn GetCursorPos(point: *mut super::super::Foundation::POINT) -> i32 {
                    let point = unsafe { &mut *point };
                    let coordinate = if crate::POINTER_INSIDE.load(crate::Ordering::Acquire) { 100 } else { 500 };
                    point.x = coordinate;
                    point.y = coordinate;
                    1
                }
                pub unsafe fn GetWindowRect(_: *mut std::ffi::c_void, rect: *mut super::super::Foundation::RECT) -> i32 {
                    let rect = unsafe { &mut *rect };
                    rect.left = 0;
                    rect.top = 0;
                    rect.right = 200;
                    rect.bottom = 200;
                    1
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
    let hide = events.iter().position(|event| event == "hide").unwrap();
    assert!(dismiss < hide);
    assert!(!events.iter().any(|event| event == "destroy"));
    drop(events);
    println!("PASS The current request is invalidated and dismissed before hiding its reusable WebView");

    EVENTS.lock().unwrap().clear();
    VISIBLE.store(true, Ordering::Release);
    FOREGROUND_READS.store(100, Ordering::Release);
    let never_focused = next_popup_generation();
    watch_popup(AppHandle, WebviewWindow, never_focused);
    wait("nonforeground-poll");
    OUTSIDE_CLICK.store(1, Ordering::Release);
    let start = Instant::now();
    while UI_QUEUE.lock().unwrap().is_empty() && start.elapsed() < Duration::from_secs(1) {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(!UI_QUEUE.lock().unwrap().is_empty(),
        "Clicking outside a nonactivating popup must close it even if Windows never granted foreground focus");
    let task = UI_QUEUE.lock().unwrap().remove(0);
    task();
    assert!(!popup_request_is_current(never_focused));
    println!("PASS An outside click dismisses the first nonactivating popup without waiting for foreground focus");

    EVENTS.lock().unwrap().clear();
    VISIBLE.store(true, Ordering::Release);
    FOREGROUND_READS.store(100, Ordering::Release);
    OUTSIDE_CLICK.store(0, Ordering::Release);
    POINTER_INSIDE.store(true, Ordering::Release);
    let inside = next_popup_generation();
    watch_popup(AppHandle, WebviewWindow, inside);
    wait("nonforeground-poll");
    OUTSIDE_CLICK.store(1, Ordering::Release);
    std::thread::sleep(Duration::from_millis(220));
    assert!(UI_QUEUE.lock().unwrap().is_empty(), "Clicks inside the popup must not dismiss its content");
    cancel_popup_request(inside);
    std::thread::sleep(Duration::from_millis(200));
    println!("PASS Clicks inside an unfocused popup remain available for its controls");

    EVENTS.lock().unwrap().clear();
    VISIBLE.store(true, Ordering::Release);
    FOREGROUND_READS.store(100, Ordering::Release);
    OUTSIDE_CLICK.store(0, Ordering::Release);
    POINTER_INSIDE.store(false, Ordering::Release);
    let escape = next_popup_generation();
    watch_popup(AppHandle, WebviewWindow, escape);
    wait("nonforeground-poll");
    ESCAPE.store(true, Ordering::Release);
    wait("close-queued");
    let task = UI_QUEUE.lock().unwrap().remove(0);
    task();
    assert!(!popup_request_is_current(escape));
    assert!(!EVENTS.lock().unwrap().iter().any(|event| event == "destroy"));
    println!("PASS Escape hides and invalidates the popup without tearing down its WebView");
}
`;
const watcherSource = path.join(output, 'popup_watchdog.rs');
const watcherExecutable = path.join(output, process.platform === 'win32' ? 'popup_watchdog.exe' : 'popup_watchdog');
await writeFile(watcherSource, watcherFixture, 'utf8');
execFileSync(rustc, ['--edition=2021', rustSource, '-o', executable], {
  stdio: 'pipe', windowsHide: true, timeout: 120000,
});
text = execFileSync(executable, [], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
text += 'PASS Native CloseRequested prevents WebView destruction and uses the reusable dismissal path\n';
execFileSync(rustc, ['--edition=2021', watcherSource, '-o', watcherExecutable], {
  stdio: 'pipe', windowsHide: true, timeout: 120000,
});
text += execFileSync(watcherExecutable, [], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
console.log(text.trim());
const checks = text.trim().split(/\r?\n/).filter((line) => line.startsWith('PASS '));
await writeFile(path.join(root, '.build/windows-popup-lifecycle.json'), `${JSON.stringify({
  source: 'desktop/patch/setup.rs',
  synthetic: true,
  checks: checks.map((name) => ({ name: name.slice(5), passed: true })),
  passed: checks.length,
}, null, 2)}\n`, 'utf8');
