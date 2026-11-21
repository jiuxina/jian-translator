// Pake 3.18.0 setup.rs + Index-Translate 桌面增强补丁
//  1. 系统托盘「划词翻译 / 设置」入口
//  2. 全局快捷键（可在应用内修改并持久化）
//  3. 划词后在鼠标旁弹出原生悬浮窗，流式显示译文
//  4. 只对本站生效（读构建时嵌入的 pake 配置），不影响其它 Pake 应用
// 原始文件保存在 desktop/patch/setup.rs.orig
use crate::app::window::{
    hide_all_app_windows, open_additional_window_safe, show_all_app_windows, toggle_all_app_windows,
};
use crate::cancel_startup_reveal;
use crate::util::UiLanguage;
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::PageLoadEvent,
    AppHandle, Manager, PhysicalPosition, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

#[cfg(target_os = "windows")]
use tauri_runtime::ResizeDirection;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "IndexTranslate";

#[derive(Clone, Debug, serde::Serialize)]
pub struct AutostartStatus {
    pub enabled: bool,
    pub target_path: Option<String>,
    pub target_exists: bool,
    pub target_is_current: bool,
}

impl Default for AutostartStatus {
    fn default() -> Self {
        Self {
            enabled: false,
            target_path: None,
            target_exists: false,
            target_is_current: false,
        }
    }
}

const DEFAULT_SELECTION_SHORTCUT: &str = "Ctrl+Alt+T";
const DEFAULT_CLIPBOARD_SHORTCUT: &str = "Ctrl+Alt+V";
const APP_WINDOW_LABEL: &str = "pake";
const POPUP_LABEL: &str = "pake-popup";
// 窗口比卡片大一圈，给 CSS 阴影留出渲染空间（否则阴影会被窗口边界裁掉）
const POPUP_WIDTH: f64 = 436.0;
const POPUP_HEIGHT: f64 = 282.0;
const POPUP_CARD_WIDTH: f64 = 392.0;
const POPUP_CARD_HEIGHT: f64 = 238.0;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct DesktopSettings {
    pub selection_shortcut: String,
    pub activation_shortcut: String,
    pub clipboard_shortcut: String,
    pub open_main_window: bool,
    pub target_lang: String,
    pub auto_start: bool,
    /// 启动时直接藏进托盘、不弹主窗口。默认关闭，可在设置面板启用。
    pub start_to_tray: bool,
    /// 前端偏好由前端校验；桌面只负责可靠持久化和投影外观到划词浮窗。
    pub preferences: serde_json::Value,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            selection_shortcut: DEFAULT_SELECTION_SHORTCUT.to_string(),
            activation_shortcut: "Ctrl+Alt+I".to_string(),
            clipboard_shortcut: DEFAULT_CLIPBOARD_SHORTCUT.to_string(),
            open_main_window: false,
            target_lang: "auto".to_string(),
            auto_start: false,
            start_to_tray: false,
            preferences: serde_json::Value::Null,
        }
    }
}

static SETTINGS: Mutex<Option<DesktopSettings>> = Mutex::new(None);
static AUTOSTART_LOCK: Mutex<()> = Mutex::new(());
static HOTKEYS_ENABLED: AtomicBool = AtomicBool::new(true);
static CLIPBOARD_TRANSACTION: Mutex<()> = Mutex::new(());
// 每次划词请求使用递增 ID，同一请求从等待阶段推进到结果阶段
static POPUP_SEQ: AtomicU64 = AtomicU64::new(0);
// watchdog 代次：新翻译顶掉旧 watchdog，避免多个线程同时盯一个窗口
static POPUP_GENERATION: AtomicU64 = AtomicU64::new(0);
static POPUP_CREATION: Mutex<()> = Mutex::new(());

fn settings_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("desktop-settings.json"))
}

/// 构建期决定本次启动是否直接藏进托盘。
/// `--start-to-tray` 是编译进 pake.json 的静态值，改一次要重新打包；
/// 这里让设置面板的「启动后最小化到托盘」在每次启动时覆盖它。
/// lib.rs 拿到 AppHandle 之前就要算这个值，所以直接按
/// %APPDATA%/<identifier>/desktop-settings.json 读（与 settings_file 同一路径）。
#[cfg(target_os = "windows")]
pub fn start_to_tray_enabled(cli_default: bool, identifier: &str) -> bool {
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return cli_default;
    };
    let path = PathBuf::from(appdata)
        .join(identifier)
        .join("desktop-settings.json");
    let Ok(text) = fs::read_to_string(path) else {
        return cli_default;
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|value| value.get("start_to_tray").and_then(|flag| flag.as_bool()))
        .unwrap_or(cli_default)
}

#[cfg(not(target_os = "windows"))]
pub fn start_to_tray_enabled(cli_default: bool, _identifier: &str) -> bool {
    cli_default
}

fn load_settings(app: &AppHandle, cli_activation: &str) -> DesktopSettings {
    let saved = settings_file(app).and_then(|path| fs::read_to_string(path).ok());
    let has_clipboard_shortcut = saved.as_ref()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .is_some_and(|value| value.get("clipboard_shortcut").is_some());
    let mut settings = saved
        .and_then(|text| serde_json::from_str::<DesktopSettings>(&text).ok())
        .unwrap_or_default();
    if settings.selection_shortcut.trim().is_empty() {
        settings.selection_shortcut = DEFAULT_SELECTION_SHORTCUT.to_string();
    }
    if settings.activation_shortcut.trim().is_empty() && !cli_activation.is_empty() {
        settings.activation_shortcut = cli_activation.to_string();
    }
    if !has_clipboard_shortcut || settings.clipboard_shortcut.trim().is_empty() {
        settings.clipboard_shortcut = default_clipboard_shortcut(&settings);
    }
    if settings.target_lang.is_empty() {
        settings.target_lang = "auto".to_string();
    }
    settings
}

fn default_clipboard_shortcut(settings: &DesktopSettings) -> String {
    let occupied = [&settings.activation_shortcut, &settings.selection_shortcut]
        .into_iter()
        .filter_map(|value| Shortcut::from_str(value.trim()).ok())
        .collect::<Vec<_>>();
    [DEFAULT_CLIPBOARD_SHORTCUT, "Ctrl+Alt+Shift+V", "Ctrl+Alt+Shift+B"]
        .into_iter()
        .find(|candidate| {
            Shortcut::from_str(candidate)
                .ok()
                .is_some_and(|parsed| !occupied.iter().any(|used| used == &parsed))
        })
        .unwrap_or(DEFAULT_CLIPBOARD_SHORTCUT)
        .to_string()
}

fn atomic_replace(source: &std::path::Path, destination: &std::path::Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let moved = unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if moved == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::rename(source, destination)
    }
}

fn persist_settings(app: &AppHandle, settings: &DesktopSettings) -> Result<(), String> {
    let path = settings_file(app).ok_or_else(|| "无法确定桌面设置目录".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "桌面设置路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建桌面设置目录：{error}"))?;
    let text = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("无法序列化桌面设置：{error}"))?;
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_nanos())
        .unwrap_or_default();
    let temporary = parent.join(format!(
        ".desktop-settings.json.{}.{}.tmp",
        std::process::id(),
        suffix
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("无法创建桌面设置临时文件：{error}"))?;
    use std::io::Write;
    file.write_all(&text)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("无法写入桌面设置：{error}"))?;
    drop(file);
    atomic_replace(&temporary, &path).map_err(|error| format!("无法保存桌面设置：{error}"))
}

fn current_settings() -> DesktopSettings {
    SETTINGS
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_default()
}

fn store_settings(settings: DesktopSettings) {
    if let Ok(mut guard) = SETTINGS.lock() {
        *guard = Some(settings);
    }
}

fn parse_shortcut(value: &str) -> Option<Shortcut> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Shortcut::from_str(trimmed).ok()
    }
}

fn register_shortcuts(app: &AppHandle, settings: &DesktopSettings) -> Vec<String> {
    let mut errors = Vec::new();
    let manager = app.global_shortcut();
    if let Some(shortcut) = parse_shortcut(&settings.activation_shortcut) {
        if let Err(error) = manager.register(shortcut) {
            errors.push(format!(
                "显示窗口快捷键「{}」注册失败：{error}",
                settings.activation_shortcut
            ));
        }
    }
    if let Some(shortcut) = parse_shortcut(&settings.selection_shortcut) {
        if let Err(error) = manager.register(shortcut) {
            errors.push(format!(
                "划词快捷键「{}」注册失败：{error}",
                settings.selection_shortcut
            ));
        }
    }
    if let Some(shortcut) = parse_shortcut(&settings.clipboard_shortcut) {
        if let Err(error) = manager.register(shortcut) {
            errors.push(format!(
                "剪贴板翻译快捷键「{}」注册失败：{error}",
                settings.clipboard_shortcut
            ));
        }
    }
    errors
}

fn unregister_shortcuts(app: &AppHandle, settings: &DesktopSettings) {
    let manager = app.global_shortcut();
    if let Some(shortcut) = parse_shortcut(&settings.activation_shortcut) {
        let _ = manager.unregister(shortcut);
    }
    if let Some(shortcut) = parse_shortcut(&settings.selection_shortcut) {
        let _ = manager.unregister(shortcut);
    }
    if let Some(shortcut) = parse_shortcut(&settings.clipboard_shortcut) {
        let _ = manager.unregister(shortcut);
    }
}

// ---------------------------------------------------------------------------
// 自绘标题栏：让 Tauri 的拖动/缩放覆盖层鼠标穿透
// ---------------------------------------------------------------------------
// 无边框窗口上 Tauri 会创建一个铺满客户区的 TAURI_DRAG_RESIZE_BORDERS 子窗口
// 来处理边缘缩放与拖动，它会吞掉网页的所有鼠标事件（点击、hover 都收不到）。
// 这里给它加上 WS_EX_TRANSPARENT，让事件落到下面的 WebView；拖动改由页面
// 调 it_window_action("drag") 触发。
#[cfg(target_os = "windows")]
fn make_drag_overlay_click_through(app: &AppHandle) {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, GetClassNameW, ShowWindow, SW_HIDE,
    };

    unsafe extern "system" fn visit(child: HWND, _param: LPARAM) -> windows_sys::core::BOOL {
        use windows_sys::Win32::Foundation::RECT;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;

        let mut buffer = [0u16; 64];
        let len = GetClassNameW(child, buffer.as_mut_ptr(), buffer.len() as i32);
        if len <= 0 {
            return 1;
        }
        let name = String::from_utf16_lossy(&buffer[..len as usize]);

        // Tauri 的拖动/缩放覆盖层铺满客户区；
        // 另外 WebView2 顶部还有一条约 25px 高的 Chrome_WidgetWin_0 也会截走点击。
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        GetWindowRect(child, &mut rect);
        let is_thin_overlay = name == "Chrome_WidgetWin_0" && (rect.bottom - rect.top) < 60;

        if name == "TAURI_DRAG_RESIZE_BORDERS" || is_thin_overlay {
            // 直接隐藏最彻底：WS_EX_TRANSPARENT 仍会让它参与命中测试
            ShowWindow(child, SW_HIDE);
        }
        1
    }

    let Some(window) = app.get_webview_window(APP_WINDOW_LABEL) else {
        return;
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        EnumChildWindows(hwnd.0 as _, Some(visit), 0);
    }
}

#[cfg(not(target_os = "windows"))]
fn make_drag_overlay_click_through(_app: &AppHandle) {}

// ---------------------------------------------------------------------------
// Windows 主窗口使用 22 个逻辑像素圆角；最大化/全屏恢复完整工作区。
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn update_main_window_corners(hwnd: windows_sys::Win32::Foundation::HWND) {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateRectRgn, CreateRoundRectRgn, DeleteObject, EqualRgn, GetMonitorInfoW, GetWindowRgn,
        MonitorFromWindow, SetWindowRgn, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsIconic, IsZoomed};

    // SAFETY: the caller supplies the live main-window HWND on its window thread.
    unsafe {
        if IsIconic(hwnd) != 0 {
            return;
        }
        let mut bounds = RECT::default();
        if GetWindowRect(hwnd, &mut bounds) == 0 {
            return;
        }
        let width = bounds.right - bounds.left;
        let height = bounds.bottom - bounds.top;
        if width <= 0 || height <= 0 {
            return;
        }
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let fullscreen = !monitor.is_null()
            && GetMonitorInfoW(monitor, &mut info) != 0
            && bounds.left <= info.rcMonitor.left
            && bounds.top <= info.rcMonitor.top
            && bounds.right >= info.rcMonitor.right
            && bounds.bottom >= info.rcMonitor.bottom;
        let square = IsZoomed(hwnd) != 0 || fullscreen;

        let previous = CreateRectRgn(0, 0, 0, 0);
        if previous.is_null() {
            return;
        }
        let has_region = GetWindowRgn(hwnd, previous) != 0;
        if square {
            // A custom region must not cut the taskbar/work-area edges when maximized.
            if has_region && SetWindowRgn(hwnd, std::ptr::null_mut(), 1) == 0 {
                eprintln!("[IT] 清除最大化窗口圆角裁剪失败");
            }
            let _ = DeleteObject(previous);
            return;
        }

        const CORNER_RADIUS_DIP: u32 = 22;
        let dpi = GetDpiForWindow(hwnd).max(96);
        let radius = ((CORNER_RADIUS_DIP * dpi + 48) / 96) as i32;
        let diameter = (radius * 2).min(width).min(height);
        let region = CreateRoundRectRgn(0, 0, width + 1, height + 1, diameter, diameter);
        if region.is_null() {
            let _ = DeleteObject(previous);
            return;
        }
        let unchanged = has_region && EqualRgn(previous, region) != 0;
        let _ = DeleteObject(previous);
        if unchanged {
            let _ = DeleteObject(region);
        } else if SetWindowRgn(hwnd, region, 1) == 0 {
            // Windows takes ownership only after a successful SetWindowRgn.
            let _ = DeleteObject(region);
            eprintln!("[IT] 应用主窗口圆角裁剪失败");
        }
    }
}

#[cfg(target_os = "windows")]
fn apply_window_border(window: &WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmExtendFrameIntoClientArea, DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE,
    };
    use windows_sys::Win32::UI::Controls::MARGINS;
    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    let color = DWMWA_COLOR_NONE;
    // SAFETY: HWND belongs to the live main window; the pointed value remains valid for the call.
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd.0 as _,
            DWMWA_BORDER_COLOR as u32,
            &color as *const u32 as *const _,
            std::mem::size_of_val(&color) as u32,
        )
    };
    if result != 0 {
        eprintln!(
            "[IT] 禁用 Windows 窗口激活边框失败：HRESULT 0x{:08X}",
            result as u32
        );
    }
    // Keep the native frame shadow around the explicitly clipped window.
    // The existing NCCALCSIZE handler still removes the unwanted top inset.
    let margins = MARGINS {
        cxLeftWidth: 1,
        cxRightWidth: 1,
        cyTopHeight: 1,
        cyBottomHeight: 1,
    };
    // SAFETY: HWND and MARGINS are valid throughout this synchronous DWM call.
    let result = unsafe { DwmExtendFrameIntoClientArea(hwnd.0 as _, &margins) };
    if result != 0 {
        eprintln!(
            "[IT] 保留圆角窗口原生阴影失败：HRESULT 0x{:08X}",
            result as u32
        );
    }
    update_main_window_corners(hwnd.0 as _);
}

#[cfg(not(target_os = "windows"))]
fn apply_window_border(_window: &WebviewWindow) {}

#[cfg(target_os = "windows")]
unsafe extern "system" fn remove_top_frame_inset(
    hwnd: windows_sys::Win32::Foundation::HWND,
    message: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
    subclass_id: usize,
    _reference: usize,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IsZoomed, NCCALCSIZE_PARAMS, WM_DISPLAYCHANGE, WM_DPICHANGED, WM_DWMCOMPOSITIONCHANGED,
        WM_NCCALCSIZE, WM_NCDESTROY, WM_SIZE, WM_WINDOWPOSCHANGED,
    };

    if message == WM_NCCALCSIZE && wparam != 0 && lparam != 0 {
        // SAFETY: Windows supplies a live NCCALCSIZE_PARAMS for WM_NCCALCSIZE with wParam set.
        let params = unsafe { &mut *(lparam as *mut NCCALCSIZE_PARAMS) };
        let proposed = params.rgrc[0];
        let result = DefSubclassProc(hwnd, message, wparam, lparam);
        // Tao's undecorated-shadow path reserves the resize shadow on all four
        // sides. The page already paints the complete rounded window, so any
        // such reservation becomes a visible white strip. Keep Tao's
        // maximized work-area calculation, but restore the proposed outer
        // rectangle for a normal window so the WebView client reaches every
        // edge. The callback runs after DefSubclassProc by design.
        if unsafe { IsZoomed(hwnd) } == 0 {
            params.rgrc[0] = proposed;
        }
        return result;
    }

    let result = DefSubclassProc(hwnd, message, wparam, lparam);
    if message == WM_NCDESTROY {
        let _ = RemoveWindowSubclass(hwnd, Some(remove_top_frame_inset), subclass_id);
    } else if matches!(
        message,
        WM_SIZE | WM_DPICHANGED | WM_WINDOWPOSCHANGED | WM_DISPLAYCHANGE | WM_DWMCOMPOSITIONCHANGED
    ) {
        update_main_window_corners(hwnd);
    }
    result
}

#[cfg(target_os = "windows")]
fn remove_main_window_top_frame_inset(window: &WebviewWindow) {
    use windows_sys::Win32::UI::Shell::SetWindowSubclass;

    const MAIN_WINDOW_SUBCLASS_ID: usize = 0x4954;
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let result = unsafe {
        SetWindowSubclass(
            hwnd.0 as _,
            Some(remove_top_frame_inset),
            MAIN_WINDOW_SUBCLASS_ID,
            0,
        )
    };
    if result == 0 {
        eprintln!("[IT] 修正 Windows 窗口顶部非客户区失败");
    }
}

#[cfg(not(target_os = "windows"))]
fn remove_main_window_top_frame_inset(_window: &WebviewWindow) {}

fn popup_appearance(settings: &DesktopSettings) -> serde_json::Value {
    let preferences = settings.preferences.as_object();
    let appearance = preferences
        .and_then(|preferences| preferences.get("appearance"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let background = preferences
        .and_then(|preferences| preferences.get("background"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let popup = preferences
        .and_then(|preferences| preferences.get("popup"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let liquid_glass = preferences
        .and_then(|preferences| preferences.get("liquidGlass"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    serde_json::json!({
        "appearance": appearance,
        "background": background,
        "popup": popup,
        "liquidGlass": liquid_glass
    })
}

fn popup_appearance_script(preferences: &serde_json::Value) -> String {
    let preferences = serde_json::to_string(preferences).unwrap_or_else(|_| "null".to_string());
    format!(
        "(function(){{var p={};window.__itPopupAppearance=p;\
         if(window.__popupApplyPreferences)window.__popupApplyPreferences(p);}})();",
        preferences
    )
}

fn sync_popup_appearance(app: &AppHandle, settings: &DesktopSettings) {
    let Some(popup) = app.get_webview_window(POPUP_LABEL) else {
        return;
    };
    let script = popup_appearance_script(&popup_appearance(settings));
    let _ = app.run_on_main_thread(move || {
        let _ = popup.eval(&script);
    });
}

#[cfg(target_os = "windows")]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
struct RunKey(windows_sys::Win32::System::Registry::HKEY);

#[cfg(target_os = "windows")]
impl Drop for RunKey {
    fn drop(&mut self) {
        use windows_sys::Win32::System::Registry::RegCloseKey;
        // SAFETY: RunKey can only be constructed from a successful registry
        // open/create call and owns that handle until this single close.
        unsafe { RegCloseKey(self.0) };
    }
}

#[cfg(target_os = "windows")]
fn open_run_key(access: u32, create: bool) -> Result<Option<RunKey>, String> {
    use windows_sys::Win32::System::Registry::{RegCreateKeyExW, RegOpenKeyExW, HKEY_CURRENT_USER};
    let subkey = wide(RUN_KEY);
    let mut key: windows_sys::Win32::System::Registry::HKEY = std::ptr::null_mut();
    // SAFETY: subkey is NUL-terminated and remains alive for the call; key is
    // a valid writable out pointer and optional outputs are allowed to be null.
    let result = if create {
        unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                std::ptr::null(),
                0,
                access,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            )
        }
    } else {
        unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, access, &mut key) }
    };
    if result == 0 {
        Ok(Some(RunKey(key)))
    } else if !create && result == 2 {
        Ok(None)
    } else {
        Err(format!("无法打开启动项注册表键（Win32 错误 {result}）"))
    }
}

#[cfg(target_os = "windows")]
fn read_autostart_target() -> Result<Option<String>, String> {
    use windows_sys::Win32::System::Environment::ExpandEnvironmentStringsW;
    use windows_sys::Win32::System::Registry::{RegQueryValueExW, REG_EXPAND_SZ, REG_SZ};
    let Some(run_key) = open_run_key(windows_sys::Win32::System::Registry::KEY_QUERY_VALUE, false)?
    else {
        return Ok(None);
    };
    let key = run_key.0;
    let name = wide(RUN_VALUE);
    let mut size: u32 = 0;
    let mut kind: u32 = 0;
    // SAFETY: name is NUL-terminated; kind and size are writable outputs, and
    // a null data pointer with zero size is the documented size query form.
    let mut result = unsafe {
        RegQueryValueExW(
            key,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if result == 2 {
        return Ok(None);
    }
    if result != 0 {
        return Err(format!("读取开机自启失败（Win32 错误 {result}）"));
    }
    if size > 32768 || (kind != REG_SZ && kind != REG_EXPAND_SZ) {
        return Ok(Some(String::new()));
    }
    if size == 0 {
        return Ok(Some(String::new()));
    }
    let mut data = vec![0u16; (size as usize).div_ceil(2)];
    let mut attempts = 0;
    loop {
        attempts += 1;
        let mut bytes = (data.len() * 2) as u32;
        // SAFETY: data is aligned u16 storage with the advertised byte capacity;
        // name and all out parameters remain valid for the registry call.
        result = unsafe {
            RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                data.as_mut_ptr().cast(),
                &mut bytes,
            )
        };
        if result != 234 {
            size = bytes;
            break;
        }
        if attempts >= 5 || bytes > 65536 || bytes as usize <= data.len() * 2 {
            return Err("自启动目标路径超出读取上限".to_string());
        }
        data.resize((bytes as usize).div_ceil(2), 0);
    }
    if result != 0 {
        return Err(format!("读取开机自启路径失败（Win32 错误 {result}）"));
    }
    if kind != REG_SZ && kind != REG_EXPAND_SZ {
        return Ok(Some(String::new()));
    }
    let units = data[..(size as usize / 2).min(data.len())]
        .iter()
        .take_while(|unit| **unit != 0)
        .copied()
        .collect::<Vec<_>>();
    let value = String::from_utf16_lossy(&units).trim().to_string();
    if value.is_empty() {
        return Ok(Some(String::new()));
    }
    let value = if kind == REG_EXPAND_SZ {
        let input = wide(&value);
        // SAFETY: input is NUL-terminated; null output with zero capacity asks
        // for the required UTF-16 buffer size.
        let required =
            unsafe { ExpandEnvironmentStringsW(input.as_ptr(), std::ptr::null_mut(), 0) };
        if required == 0 || required > 32768 {
            return Err("无法展开自启动目标中的环境变量".to_string());
        }
        let mut expanded = vec![0u16; required as usize];
        // SAFETY: expanded is writable UTF-16 storage sized by the preceding
        // query and input remains alive and NUL-terminated.
        let written =
            unsafe { ExpandEnvironmentStringsW(input.as_ptr(), expanded.as_mut_ptr(), required) };
        if written == 0 || written > required {
            return Err("无法展开自启动目标中的环境变量".to_string());
        }
        String::from_utf16_lossy(&expanded[..written.saturating_sub(1) as usize])
    } else {
        value
    };
    let value = value.trim();
    if let Some(stripped) = value.strip_prefix('"') {
        let Some(end) = stripped.find('"') else {
            return Ok(Some(String::new()));
        };
        let executable = &stripped[..end];
        return Ok(Some(executable.to_string()));
    }
    let value = value.trim();
    let Some(extension_start) = value.to_ascii_lowercase().find(".exe") else {
        return Ok(Some(String::new()));
    };
    if value[..extension_start].contains(char::is_whitespace) {
        return Ok(Some(String::new()));
    }
    let extension_end = extension_start + 4;
    if !value[extension_end..].starts_with(char::is_whitespace)
        && !value[extension_end..].is_empty()
    {
        return Ok(Some(String::new()));
    }
    let executable = value[..extension_end].trim();
    if executable.is_empty() {
        return Ok(Some(String::new()));
    }
    Ok(Some(executable.to_string()))
}

#[cfg(not(target_os = "windows"))]
fn read_autostart_target() -> Result<Option<String>, String> {
    Ok(None)
}

fn same_executable_path(left: &Path, right: &Path) -> bool {
    let left = fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

fn autostart_status() -> Result<AutostartStatus, String> {
    let _guard = AUTOSTART_LOCK
        .lock()
        .map_err(|_| "自启动状态锁已损坏".to_string())?;
    let target_path = read_autostart_target()?;
    let Some(target_path) = target_path else {
        return Ok(AutostartStatus::default());
    };
    if target_path.is_empty() {
        return Ok(AutostartStatus {
            enabled: true,
            target_path: None,
            target_exists: false,
            target_is_current: false,
        });
    }
    let target = PathBuf::from(&target_path);
    if !target.is_absolute() {
        return Ok(AutostartStatus {
            enabled: true,
            target_path: None,
            target_exists: false,
            target_is_current: false,
        });
    }
    let target_exists = target.exists();
    let current =
        std::env::current_exe().map_err(|error| format!("取不到当前程序路径：{error}"))?;
    let target_is_current = same_executable_path(&target, &current);
    Ok(AutostartStatus {
        enabled: true,
        target_path: Some(target_path),
        target_exists,
        target_is_current,
    })
}

#[cfg(target_os = "windows")]
fn apply_autostart(enabled: bool) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::{RegDeleteValueW, RegSetValueExW, REG_SZ};
    let _guard = AUTOSTART_LOCK
        .lock()
        .map_err(|_| "自启动状态锁已损坏".to_string())?;
    let executable = if enabled {
        Some(std::env::current_exe().map_err(|error| format!("取不到程序路径：{error}"))?)
    } else {
        None
    };
    let Some(run_key) = open_run_key(windows_sys::Win32::System::Registry::KEY_SET_VALUE, enabled)?
    else {
        return Ok(());
    };
    let key = run_key.0;
    let name = wide(RUN_VALUE);

    let result = if let Some(executable) = executable {
        let value = wide(&format!("\"{}\"", executable.display()));
        let data: Vec<u8> = value.iter().flat_map(|unit| unit.to_le_bytes()).collect();
        // SAFETY: key is owned by run_key; name and data are NUL-terminated /
        // initialized buffers that remain alive until RegSetValueExW returns.
        unsafe {
            RegSetValueExW(
                key,
                name.as_ptr(),
                0,
                REG_SZ,
                data.as_ptr(),
                data.len() as u32,
            )
        }
    } else {
        // SAFETY: key and name remain valid for the duration of this call.
        unsafe { RegDeleteValueW(key, name.as_ptr()) }
    };
    // 2 = ERROR_FILE_NOT_FOUND，本来就没启用，视为成功
    if result == 0 || (!enabled && result == 2) {
        Ok(())
    } else {
        Err(format!("设置开机自启失败（Win32 错误 {result}）"))
    }
}

#[cfg(not(target_os = "windows"))]
fn apply_autostart(_enabled: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command(async)]
pub fn it_get_autostart_status() -> Result<AutostartStatus, String> {
    autostart_status()
}

#[tauri::command(async)]
pub fn it_set_autostart(enabled: bool) -> Result<AutostartStatus, String> {
    apply_autostart(enabled)?;
    autostart_status()
}

/// 自定义标题栏的窗口动作；无边框窗口还需要手动提供拖拽缩放入口。
#[tauri::command(async)]
pub fn it_window_action(app: AppHandle, action: String) -> Result<(), String> {
    // get_window() 需要 unstable feature；从 WebviewWindow 取底层 Window
    // 才能调用 start_resize_dragging（无边框窗口的拖拽缩放）。
    let window = app
        .get_webview_window(APP_WINDOW_LABEL)
        .ok_or_else(|| "主窗口不存在".to_string())?
        .as_ref()
        .window();

    #[cfg(target_os = "windows")]
    let direction = match action.as_str() {
        "resize-n" => Some(ResizeDirection::North),
        "resize-s" => Some(ResizeDirection::South),
        "resize-e" => Some(ResizeDirection::East),
        "resize-w" => Some(ResizeDirection::West),
        "resize-ne" => Some(ResizeDirection::NorthEast),
        "resize-nw" => Some(ResizeDirection::NorthWest),
        "resize-se" => Some(ResizeDirection::SouthEast),
        "resize-sw" => Some(ResizeDirection::SouthWest),
        _ => None,
    };
    #[cfg(target_os = "windows")]
    if let Some(direction) = direction {
        return window
            .start_resize_dragging(direction)
            .map_err(|error| format!("无法缩放窗口：{error}"));
    }

    match action.as_str() {
        "drag" => window
            .start_dragging()
            .map_err(|error| format!("无法拖动窗口：{error}")),
        "minimize" => window
            .minimize()
            .map_err(|error| format!("无法最小化：{error}")),
        "maximize" => if window.is_maximized().unwrap_or(false) {
            window.unmaximize()
        } else {
            window.maximize()
        }
        .map_err(|error| format!("无法切换最大化：{error}")),
        "close" => window.close().map_err(|error| format!("无法关闭：{error}")),
        _ => Err(format!("未知窗口动作：{action}")),
    }
}

/// 只有「笺」这个应用才启用托盘增强与划词热键。
/// 不能用窗口当前 URL 判断：setup 阶段 WebView 可能还停在 about:blank。
///
/// v2 起前端改为本地打包（url_type = local，入口 index.html），所以除了旧的
/// 官网地址，也要认本地入口，否则托盘增强与划词热键会被整体跳过。
fn is_translate_app(_app: &AppHandle) -> bool {
    let (pake_config, _) = crate::util::get_pake_config();
    pake_config
        .windows
        .first()
        .map(|window| {
            let url = window.url.as_str();
            url.contains("index-translate.bilibili.com")
                || url == "index.html"
                || url.ends_with("/index.html")
        })
        .unwrap_or(false)
}

struct TrayLabels {
    new_window: &'static str,
    hide: &'static str,
    show: &'static str,
    translate: &'static str,
    settings: &'static str,
    quit: &'static str,
}

impl TrayLabels {
    fn for_language(language: UiLanguage) -> Self {
        match language {
            UiLanguage::English => TrayLabels {
                new_window: "New Window",
                hide: "Hide",
                show: "Show",
                translate: "Translate selection  (Ctrl+Alt+T)",
                settings: "Settings…",
                quit: "Quit",
            },
            UiLanguage::SimplifiedChinese => TrayLabels {
                new_window: "新建窗口",
                hide: "隐藏",
                show: "显示",
                translate: "划词翻译  (Ctrl+Alt+T)",
                settings: "设置…",
                quit: "退出",
            },
            UiLanguage::TraditionalChinese => TrayLabels {
                new_window: "新增視窗",
                hide: "隱藏",
                show: "顯示",
                translate: "划詞翻譯  (Ctrl+Alt+T)",
                settings: "設定…",
                quit: "結束",
            },
        }
    }
}

// ---------------------------------------------------------------------------
// 划词悬浮窗
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn cursor_position() -> (i32, i32) {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut point = POINT { x: 0, y: 0 };
    unsafe {
        GetCursorPos(&mut point);
    }
    (point.x, point.y)
}

#[cfg(not(target_os = "windows"))]
fn cursor_position() -> (i32, i32) {
    (200, 200)
}

fn popup_payload_script(payload: &str) -> String {
    format!(
        "(function(){{var p={payload};\
         if(window.__popupApply)window.__popupApply(p);\
         else window.__itPopupPayload=p;}})();"
    )
}

/// 模板 + 数据一起投递：WebView 还没建好时 eval 会丢，Rust 侧会重复调本函数，
/// JS 用 payload.id 去重，不会重复发翻译请求。
fn deliver_popup(window: &WebviewWindow, payload: &str, appearance: &serde_json::Value) {
    let _ = window.eval(LIQUID_GLASS_ENGINE);
    let _ = window.eval(TRANSLATION_STREAM_ENGINE);
    let _ = window.eval(POPUP_BOOTSTRAP);
    let _ = window.eval(&popup_appearance_script(appearance));
    let _ = window.eval(&popup_payload_script(payload));
}

fn popup_request_is_current(generation: u64) -> bool {
    POPUP_GENERATION.load(Ordering::Acquire) == generation
}

fn next_popup_generation() -> u64 {
    POPUP_GENERATION.fetch_add(1, Ordering::AcqRel) + 1
}

fn cancel_popup_request(generation: u64) {
    let _ = POPUP_GENERATION.compare_exchange(
        generation,
        generation + 1,
        Ordering::AcqRel,
        Ordering::Acquire,
    );
}

fn popup_payload(id: u64, phase: &str, text: &str, notice: &str, target: &str) -> String {
    serde_json::json!({
        "id": id, "phase": phase, "text": text, "notice": notice, "target": target,
    })
    .to_string()
}

fn set_popup_capture_mode(window: &WebviewWindow, capturing: bool) -> Result<(), String> {
    // Keep Tao's focusability cache and native extended styles in agreement.
    // Changing only WS_EX_NOACTIVATE bypasses the framework's window state.
    window
        .set_focusable(!capturing)
        .map_err(|error| format!("无法更新划词悬浮窗聚焦状态：{error}"))
}

fn show_popup_without_focus(window: &WebviewWindow) -> Result<(), String> {
    // Capture mode is set before show. Using the framework API is essential:
    // raw ShowWindow leaves Tao's VISIBLE flag false, so later set_focus is a no-op.
    window
        .show()
        .map_err(|error| format!("无法显示划词悬浮窗：{error}"))
}

fn retry_popup_delivery(window: &WebviewWindow, payload: &str, generation: u64) {
    for delay in [150u64, 450, 1000, 2000] {
        let window = window.clone();
        let payload = payload.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay));
            if !popup_request_is_current(generation) || !window.is_visible().unwrap_or(false) {
                return;
            }
            let appearance = popup_appearance(&current_settings());
            deliver_popup(&window, &payload, &appearance);
        });
    }
}

fn complete_popup(
    app: &AppHandle,
    id: u64,
    generation: u64,
    text: &str,
    notice: &str,
    target: &str,
) {
    let payload = popup_payload(
        id,
        if notice.is_empty() { "ready" } else { "notice" },
        text,
        notice,
        target,
    );
    let handle = app.clone();
    let main_thread_app = handle.clone();
    let _ = handle.run_on_main_thread(move || {
        if !popup_request_is_current(generation) {
            return;
        }
        // Completion never creates, shows or repositions a dismissed popup.
        let Some(window) = main_thread_app.get_webview_window(POPUP_LABEL) else {
            return;
        };
        if !window.is_visible().unwrap_or(false) {
            cancel_popup_request(generation);
            return;
        }
        let focus_ready = match set_popup_capture_mode(&window, false) {
            Ok(()) => true,
            Err(error) => {
                eprintln!("[IT] {error}");
                false
            }
        };
        let appearance = popup_appearance(&current_settings());
        deliver_popup(&window, &payload, &appearance);
        if focus_ready {
            if let Err(error) = window.set_focus() {
                eprintln!("[IT] 聚焦划词悬浮窗失败：{error}");
            }
        }
        retry_popup_delivery(&window, &payload, generation);
    });
}

fn present_popup(
    app: &AppHandle,
    id: u64,
    generation: u64,
    target: &str,
    after_present: impl FnOnce() + Send + 'static,
) {
    let payload = popup_payload(id, "pending", "", "", target);
    let handle = app.clone();
    std::thread::spawn(move || {
        if !popup_request_is_current(generation) {
            return;
        }
        // WebView construction must stay off the Windows UI event handler.
        // The normal path reuses the hidden window, including after Escape.
        let Some(window) = ensure_popup(&handle) else {
            return;
        };
        let main_thread_app = handle.clone();
        if let Err(error) = handle.run_on_main_thread(move || {
            if !popup_request_is_current(generation) {
                return;
            }
            // A rapid shortcut can arrive before the old watchdog hides a popup
            // that just lost focus. Tao's style transition on a visible window
            // may use SW_SHOW, so hide through Tao before entering no-focus mode.
            if window.is_visible().unwrap_or(false) {
                if let Err(error) = window.hide() {
                    eprintln!("[IT] 隐藏旧划词悬浮窗失败：{error}");
                    cancel_popup_request(generation);
                    return;
                }
            }
            if let Err(error) = set_popup_capture_mode(&window, true) {
                eprintln!("[IT] {error}");
                cancel_popup_request(generation);
                return;
            }
            let appearance = popup_appearance(&current_settings());
            deliver_popup(&window, &payload, &appearance);
            position_popup(&main_thread_app, &window);
            if let Err(error) = show_popup_without_focus(&window) {
                eprintln!("[IT] {error}");
                cancel_popup_request(generation);
                return;
            }
            let _ = window.eval(
                "window.__itPopupPresentRequested=true;window.__popupPresent&&window.__popupPresent()",
            );
            retry_popup_delivery(&window, &payload, generation);
            watch_popup(main_thread_app.clone(), window, generation);
            after_present();
        }) {
            eprintln!("[IT] 调度划词悬浮窗显示失败：{error}");
        }
    });
}

fn ensure_popup(app: &AppHandle) -> Option<WebviewWindow> {
    let _creation = POPUP_CREATION.lock().ok()?;
    if let Some(window) = app.get_webview_window(POPUP_LABEL) {
        return Some(window);
    }

    let blank = Url::parse("about:blank").ok()?;
    let builder = WebviewWindowBuilder::new(app, POPUP_LABEL, WebviewUrl::External(blank))
        .title("划词翻译")
        .inner_size(POPUP_WIDTH, POPUP_HEIGHT)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .visible(false)
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = window.eval(LIQUID_GLASS_ENGINE);
                let _ = window.eval(TRANSLATION_STREAM_ENGINE);
                let _ = window.eval(POPUP_BOOTSTRAP);
            }
        });

    builder.build().ok().map(|window| {
        // about:blank 不一定触发 PageLoadEvent，创建后立即注入模板；
        // 载入阶段会补投同一 payload，模板按请求与阶段幂等处理。
        let _ = window.eval(LIQUID_GLASS_ENGINE);
        let _ = window.eval(TRANSLATION_STREAM_ENGINE);
        let _ = window.eval(POPUP_BOOTSTRAP);
        let popup_handle = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let generation = POPUP_GENERATION.load(Ordering::Acquire);
                if let Some(popup) = popup_handle.get_webview_window(POPUP_LABEL) {
                    dismiss_popup_if_current(&popup_handle, &popup, generation);
                }
            }
        });
        window
    })
}

fn position_popup(app: &AppHandle, window: &WebviewWindow) {
    let (cursor_x, cursor_y) = cursor_position();
    let scale = window.scale_factor().unwrap_or(1.0);
    // 卡片四周留了透明边距给阴影，定位时按卡片而不是窗口算
    let pad_x = (POPUP_WIDTH - POPUP_CARD_WIDTH) / 2.0;
    let pad_y = (POPUP_HEIGHT - POPUP_CARD_HEIGHT) / 2.0;
    let card_w = POPUP_CARD_WIDTH * scale;
    let card_h = POPUP_CARD_HEIGHT * scale;

    let mut card_x = cursor_x as f64 + 18.0;
    let mut card_y = cursor_y as f64 + 22.0;

    if let Ok(Some(monitor)) = app.monitor_from_point(cursor_x as f64, cursor_y as f64) {
        let origin = monitor.position();
        let size = monitor.size();
        let right = origin.x as f64 + size.width as f64;
        let bottom = origin.y as f64 + size.height as f64;
        if card_x + card_w > right {
            card_x = cursor_x as f64 - card_w - 18.0;
        }
        if card_y + card_h > bottom {
            card_y = cursor_y as f64 - card_h - 22.0;
        }
        if card_x < origin.x as f64 + 8.0 {
            card_x = origin.x as f64 + 8.0;
        }
        if card_y < origin.y as f64 + 8.0 {
            card_y = origin.y as f64 + 8.0;
        }
    }

    let x = card_x - pad_x * scale;
    let y = card_y - pad_y * scale;
    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

fn dismiss_popup_if_current(app: &AppHandle, window: &WebviewWindow, generation: u64) {
    let window = window.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        // Showing and closing are serialized on the UI thread. Claim only this
        // request immediately before hiding; a queued old watchdog
        // must not close a window already reused by a newer shortcut.
        if POPUP_GENERATION
            .compare_exchange(
                generation,
                generation + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_err()
        {
            return;
        }
        let _ = window.eval("window.__popupDismiss&&window.__popupDismiss()");
        if let Err(error) = window.hide() {
            eprintln!("[IT] 隐藏划词悬浮窗失败：{error}");
        }
    }) {
        eprintln!("[IT] 调度划词悬浮窗关闭失败：{error}");
    }
}

#[cfg(target_os = "windows")]
fn popup_pointer_buttons() -> (u8, u8) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON,
    };
    let mut down = 0u8;
    let mut pressed = 0u8;
    for (index, button) in [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON].into_iter().enumerate() {
        // Read only button state while this popup is active; no input is logged.
        let state = unsafe { GetAsyncKeyState(button as i32) } as u16;
        if state & 0x8000 != 0 {
            down |= 1 << index;
        }
        if state & 1 != 0 {
            pressed |= 1 << index;
        }
    }
    (down, pressed)
}

#[cfg(target_os = "windows")]
fn popup_pointer_pressed_outside(window: &WebviewWindow, previous_buttons: &mut u8) -> bool {
    use windows_sys::Win32::Foundation::{POINT, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect};

    let (down, pressed) = popup_pointer_buttons();
    let clicked = (down | pressed) & !*previous_buttons != 0;
    *previous_buttons = down;
    if !clicked {
        return false;
    }
    let Ok(hwnd) = window.hwnd() else {
        return false;
    };
    let mut pointer = POINT::default();
    let mut rect = RECT::default();
    // SAFETY: both outputs are initialized stack values and the HWND is live.
    if unsafe { GetCursorPos(&mut pointer) == 0 || GetWindowRect(hwnd.0, &mut rect) == 0 } {
        return false;
    }
    pointer.x < rect.left
        || pointer.x >= rect.right
        || pointer.y < rect.top
        || pointer.y >= rect.bottom
}

fn watch_popup(app: AppHandle, window: WebviewWindow, generation: u64) {
    #[cfg(target_os = "windows")]
    let mut previous_buttons = popup_pointer_buttons().0;
    std::thread::spawn(move || {
        let mut seen_foreground = false;
        let mut ticks = 0u32;
        loop {
            std::thread::sleep(Duration::from_millis(160));
            ticks += 1;

            // 已经发起新一轮翻译，旧 watchdog 直接退出
            if POPUP_GENERATION.load(Ordering::Relaxed) != generation {
                break;
            }
            if !window.is_visible().unwrap_or(false) {
                cancel_popup_request(generation);
                break;
            }
            // 长时间没被聚焦（系统限制了后台抢焦点）就自动收起，避免一直挂着
            if !seen_foreground && ticks > 90 {
                dismiss_popup_if_current(&app, &window, generation);
                break;
            }

            #[cfg(target_os = "windows")]
            {
                use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
                use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

                // The source keeps focus during capture, and Windows may reject
                // later activation. Outside pointer dismissal must work in both cases.
                if popup_pointer_pressed_outside(&window, &mut previous_buttons) {
                    dismiss_popup_if_current(&app, &window, generation);
                    break;
                }
                let foreground = unsafe { GetForegroundWindow() };
                let mine = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
                let is_me = foreground as isize == mine;
                if is_me {
                    seen_foreground = true;
                } else if seen_foreground && ticks % 2 == 0 {
                    // 再确认一次，避免焦点切换瞬间误关
                    std::thread::sleep(Duration::from_millis(120));
                    if !popup_request_is_current(generation) {
                        break;
                    }
                    let again = unsafe { GetForegroundWindow() };
                    if again as isize != mine {
                        dismiss_popup_if_current(&app, &window, generation);
                        break;
                    }
                }

                // 低位表示「上次查询后按下过」，能捕获很快的 Esc 轻点
                let esc = unsafe { GetAsyncKeyState(0x1B) } as u16 & 0x8001 != 0;
                if esc {
                    dismiss_popup_if_current(&app, &window, generation);
                    break;
                }
            }

            #[cfg(not(target_os = "windows"))]
            {
                let _ = &app;
                let _ = seen_foreground;
                let _ = ticks;
            }
        }
    });
}

/// 悬浮窗页面：纯 HTML/CSS/JS，直接调官网同源接口，流式渲染。
/// Rust 会重复投递「模板 + 数据」；模板幂等，数据按 id 去重。
const LIQUID_GLASS_ENGINE: &str = include_str!("liquid-glass.js");
const TRANSLATION_STREAM_ENGINE: &str = include_str!("translation-stream.js");

const POPUP_BOOTSTRAP: &str = r#"
(function () {
if (window.__popupBooted && window.__popupApply && document.getElementById('out')) {
  if (window.__itPopupAppearance && window.__popupApplyPreferences) {
    window.__popupApplyPreferences(window.__itPopupAppearance);
  }
  if (window.__itPopupPayload) window.__popupApply(window.__itPopupPayload);
  if (window.__itPopupPresentRequested && window.__popupPresent) window.__popupPresent();
  return;
}
document.documentElement.innerHTML = `
<head><meta charset="utf-8"><style>
  /* 悬浮窗卡片使用静态磨砂；复制按钮与主界面共用液态玻璃引擎。 */
  :root{--lg-edge:rgba(255,255,255,.38);--lg-edge-dark:rgba(70,52,96,.09);
    --lg-scrollbar-thumb:rgba(70,52,96,.22);
    --lg-ink:#2E2A38;--lg-ink-sub:#6E687E;
    --lg-ink-faint:#A29CAC;--lg-accent:#E28BA6;--lg-accent-deep:#C96F90;
    --lg-accent-wash:rgba(226,139,166,.18);--user-font-scale:1;
    --lg-r-lg:26px;
    --lg-duration-fast:140ms;--lg-duration-control:220ms;--lg-duration-panel:280ms;
    --lg-ease-enter:cubic-bezier(.18,.8,.22,1);
    --it-popup-bg-overlay:rgba(255,255,255,0);--it-popup-bg-blur:0px;--it-popup-bg-fit:cover;
    --it-popup-bg-inset:0px;
    --it-liquid-tint-rgb:255 255 255;
    --it-popup-content-color:var(--lg-ink);--it-popup-content-weight:400;
    --it-popup-content-font:"PingFang SC","Microsoft YaHei UI","Noto Sans SC",system-ui,sans-serif;
    /* 悬浮窗是 436x282 的透明窗口，卡片四周只有 22px 留白。
       阴影和折射滤镜需收敛在这个范围内，避免窗口裁切产生硬边。 */
    --lg-shadow-strong:0 6px 20px rgba(70,52,96,.14),0 2px 6px rgba(70,52,96,.05);}
  html,body{margin:0;padding:0;height:100%;background:transparent;overflow:hidden;
    font-family:"PingFang SC","Microsoft YaHei UI","Noto Sans SC",system-ui,sans-serif;
    font-weight:var(--it-popup-content-weight);
    -webkit-font-smoothing:antialiased;}
  *{-webkit-user-select:none;user-select:none;}
  #out,#out *{-webkit-user-select:text;user-select:text;}
  body{box-sizing:border-box;padding:22px;position:relative;isolation:isolate;}
  #card-frame{height:100%;position:relative;isolation:isolate;border-radius:var(--lg-r-lg);
    box-shadow:var(--lg-shadow-strong);
    transform-origin:center;}
  html[data-popup-present="true"] #card-frame{
    animation:popup-arrive var(--lg-duration-panel) var(--lg-ease-enter) both;}
  #popup-background{position:absolute;z-index:0;inset:0;overflow:hidden;border-radius:inherit;pointer-events:none;}
  #popup-background::before{content:"";position:absolute;inset:var(--it-popup-bg-inset);
    background-image:var(--it-popup-background-image,none);background-position:center;background-repeat:no-repeat;
    background-size:var(--it-popup-bg-fit);filter:blur(var(--it-popup-bg-blur));}
  #popup-background::after{content:"";position:absolute;inset:0;
    background:var(--it-popup-bg-overlay);}
  #card{box-sizing:border-box;height:100%;display:flex;flex-direction:column;
    position:relative;z-index:1;isolation:isolate;overflow:hidden;
    background-color:rgb(var(--it-liquid-tint-rgb) / var(--it-liquid-background-opacity,.6));
    background-image:
      linear-gradient(145deg,rgb(var(--it-liquid-tint-rgb) / calc(var(--it-liquid-background-opacity,.6) * .12)),transparent),
      repeating-linear-gradient(135deg,rgb(var(--it-liquid-tint-rgb) / calc(var(--it-liquid-background-opacity,.6) * .045)) 0 1px,transparent 1px 3px);
    border:0;border-radius:var(--lg-r-lg);
    -webkit-backdrop-filter:none;backdrop-filter:none;}
  #card>*{position:relative;z-index:1;}
  [data-it-liquid-preset]{position:relative;isolation:isolate;}
  [data-it-liquid-background]{position:absolute;inset:0;z-index:-1;
    border-radius:inherit;pointer-events:none;}
  [data-it-liquid-background]{background:rgb(var(--it-liquid-tint-rgb) / var(--it-liquid-background-opacity,0));
    -webkit-backdrop-filter:var(--it-liquid-filter,none);backdrop-filter:var(--it-liquid-filter,none);}
  .head{display:flex;align-items:center;justify-content:space-between;gap:8px;
    padding:10px 14px 8px;font-size:12px;color:var(--lg-ink-sub);}
  .head b{font-weight:inherit;color:var(--lg-accent-deep);}
  .body{flex:1;overflow-y:auto;padding:2px 14px 12px;font-size:calc(15px * var(--user-font-scale));line-height:1.8;
    letter-spacing:.02em;color:var(--it-popup-content-color);font-weight:var(--it-popup-content-weight);
    font-family:var(--it-popup-content-font);white-space:pre-wrap;word-break:break-word;}
  @supports not selector(::-webkit-scrollbar){
    .body{scrollbar-width:thin;scrollbar-color:var(--lg-scrollbar-thumb) transparent;}}
  .body::-webkit-scrollbar{width:7px;background:transparent;}
  .body::-webkit-scrollbar-track,.body::-webkit-scrollbar-track-piece{background:transparent;}
  .body::-webkit-scrollbar-thumb{background:var(--lg-scrollbar-thumb);border:2px solid transparent;
    background-clip:padding-box;border-radius:99px;}
  .body::-webkit-scrollbar-button{display:none;width:0;height:0;}
  .body::-webkit-scrollbar-corner{background:transparent;}
  .ph{color:var(--lg-ink-sub);font-size:14px;}
  .err{color:var(--lg-accent-deep);font-size:13px;}
  .foot{display:flex;align-items:center;justify-content:space-between;
    padding:8px 12px 9px;border-top:1px solid var(--lg-edge-dark);font-size:12px;color:var(--lg-ink-sub);}
  .foot button{border:1px solid var(--lg-edge);background:transparent;
    -webkit-backdrop-filter:none;backdrop-filter:none;
    color:var(--lg-accent-deep);border-radius:999px;
    padding:5px 12px;font-size:11.5px;font-weight:inherit;cursor:pointer;
    transition:background var(--lg-duration-control),color var(--lg-duration-control);}
  .foot button:hover{border-color:var(--lg-accent);color:var(--lg-ink);}
  #glass-status{margin:0;padding:0 14px 4px;font-size:10px;color:var(--lg-accent-deep);}
  #glass-status[hidden]{display:none;}
  @keyframes popup-arrive{from{opacity:0;transform:translateY(7px) scale(.985)}to{opacity:1;transform:none}}
  .stream-segment{animation:stream-arrive 200ms ease-out both}
  @keyframes stream-arrive{from{opacity:0}to{opacity:1}}
  html[data-theme-scheme="dark"]{color-scheme:dark;}
  html[data-theme-scheme="light"]{color-scheme:light;}
  html[data-radius="standard"]{--lg-r-lg:18px;}
  html[data-radius="small"]{--lg-r-lg:10px;}
  html[data-radius="standard"] .foot button{border-radius:10px;}
  html[data-radius="small"] .foot button{border-radius:7px;}
  html[data-motion="reduced"] #card-frame{animation:none;}
  html[data-motion="off"] *,html[data-motion="off"] *::before,html[data-motion="off"] *::after{animation:none!important;transition:none!important;}
  html[data-motion="reduced"] .foot button{transition:color 140ms ease,background 140ms ease;}
  html[data-font="serif"],html[data-font="serif"] body{font-family:ui-serif,"Noto Serif CJK SC",serif;}
  html[data-font="mono"],html[data-font="mono"] body{font-family:ui-monospace,"Cascadia Mono",monospace;}
  @media(prefers-reduced-motion:reduce){#card-frame,.stream-segment,.foot button{animation:none!important;transition:none!important}}
</style></head>
<body><div id="card-frame"><div id="popup-background" aria-hidden="true"></div><div id="card">
  <div class="head"><b id="meta">翻译中</b><span id="badge"></span></div>
  <p id="glass-status" role="alert" hidden></p>
  <div class="body" id="out"><span class="ph">正在翻译…</span></div>
  <div class="foot"><span>Esc 或点击别处关闭</span><button id="copy" type="button">复制</button></div>
</div></div></body>`;

document.addEventListener('it-liquid-glass-error', function (event) {
  var status = document.getElementById('glass-status');
  if (!status) return;
  status.hidden = false;
  status.textContent = event.detail && event.detail.code === 'unsupported' ?
    '当前运行环境无法绘制液态玻璃。' : '液态玻璃初始化失败，请重新打开悬浮窗。';
});
window.ItLiquidGlass.attach(document.getElementById('copy'), 'button');

(function () {
  var output = document.getElementById('out');
  var meta = document.getElementById('meta');
  var badge = document.getElementById('badge');
  var copy = document.getElementById('copy');
  var popupBackground = document.getElementById('popup-background');
  var copyFeedbackTimer = 0;
  var lastId = 0;
  var lastPhase = -1;
  var requestRevision = 0;
  var dismissedId = 0;
  var dismissed = false;
  var controller = null;
  var paintQueue = '';
  var paintFrame = 0;

  function cancelOutputQueue() {
    if (paintFrame) cancelAnimationFrame(paintFrame);
    paintFrame = 0;
    paintQueue = '';
  }

  function flushOutputQueue(final, revision) {
    paintFrame = 0;
    if (!paintQueue || revision !== requestRevision || dismissed) return;
    var count = final ? paintQueue.length : Math.max(4, Math.min(70, Math.ceil(paintQueue.length / 5)));
    var chunk = paintQueue.slice(0, count);
    paintQueue = paintQueue.slice(count);
    if (popupMotionDisabled()) {
      output.appendChild(document.createTextNode(chunk));
    } else {
      var segment = document.createElement('span');
      segment.className = 'stream-segment';
      segment.textContent = chunk;
      segment.addEventListener('animationend', function settle() {
        if (segment.parentNode === output) output.replaceChild(document.createTextNode(chunk), segment);
      }, { once: true });
      setTimeout(function () {
        if (segment.parentNode === output) output.replaceChild(document.createTextNode(chunk), segment);
      }, 260);
      output.appendChild(segment);
    }
    if (paintQueue) paintFrame = requestAnimationFrame(function () { flushOutputQueue(false, revision); });
  }

  function queueOutput(text, revision) {
    if (revision !== requestRevision || dismissed) return;
    if (output.querySelector('.ph')) output.textContent = '';
    // Streaming text is only a preview until the transport confirms completion.
    copy.disabled = true;
    if (popupMotionDisabled()) {
      output.appendChild(document.createTextNode(text));
      return;
    }
    paintQueue += text;
    if (!paintFrame) paintFrame = requestAnimationFrame(function () { flushOutputQueue(false, revision); });
  }

  function pickTarget(text, wanted) {
    if (wanted === 'zh' || wanted === 'en') return wanted;
    return /[\u4e00-\u9fa5]/.test(text) ? 'en' : 'zh';
  }

  window.__popupPresent = function () {
    if (dismissed || !lastId || lastId <= dismissedId) return;
    window.__itPopupPresentRequested = false;
    var root = document.documentElement;
    root.removeAttribute('data-popup-present');
    void document.getElementById('card-frame').offsetWidth;
    root.setAttribute('data-popup-present', 'true');
  };

  window.__popupDismiss = function () {
    window.__itPopupPresentRequested = false;
    dismissed = true;
    dismissedId = Math.max(dismissedId, lastId);
    requestRevision++;
    cancelOutputQueue();
    if (controller) { try { controller.abort(); } catch (e) {} controller = null; }
    clearTimeout(copyFeedbackTimer);
    copy.disabled = true;
    document.documentElement.removeAttribute('data-popup-present');
    document.documentElement.dataset.popupPhase = 'dismissed';
  };

  window.__popupApply = function (p) {
    if (!p || !Number.isSafeInteger(Number(p.id)) || Number(p.id) < 1) return;
    var id = Number(p.id);
    var notice = typeof p.notice === 'string' ? p.notice : '';
    var text = typeof p.text === 'string' ? p.text : '';
    var phase = p.phase || (notice ? 'notice' : text ? 'ready' : 'pending');
    var phaseRank = phase === 'pending' ? 0 : (phase === 'ready' || phase === 'notice' ? 1 : -1);
    if (phaseRank < 0 || id < lastId || (id === lastId && id <= dismissedId) ||
        (id === lastId && phaseRank <= lastPhase)) return;

    var isNewRequest = id > lastId;
    if (isNewRequest) {
      if (controller) { try { controller.abort(); } catch (e) {} }
      controller = null;
      cancelOutputQueue();
      clearTimeout(copyFeedbackTimer);
      copy.title = '';
      copy.textContent = '复制';
      copy.disabled = true;
      requestRevision++;
      dismissed = false;
      lastId = id;
      lastPhase = -1;
      document.documentElement.removeAttribute('data-popup-present');
    }
    lastPhase = phaseRank;
    document.documentElement.dataset.popupPhase = phase;

    if (phase === 'pending') {
      meta.textContent = '翻译中';
      badge.textContent = '';
      output.innerHTML = '<span class="ph">正在翻译…</span>';
      copy.disabled = true;
      return;
    }

    var revision = requestRevision;
    cancelOutputQueue();
    if (controller) { try { controller.abort(); } catch (e) {} controller = null; }
    if (phase === 'notice') {
      meta.textContent = '提示';
      badge.textContent = '';
      output.textContent = notice;
      copy.disabled = true;
      return;
    }

    var target = pickTarget(text, p.target);
    meta.textContent = text.length > 42 ? text.slice(0, 42) + '…' : text;
    badge.textContent = target === 'en' ? '→ EN' : '→ 中文';
    output.innerHTML = '<span class="ph">正在翻译…</span>';
    copy.disabled = true;
    if (!text.trim()) return;

    controller = typeof AbortController === 'function' ? new AbortController() : null;
    var payload = {
        model: 'index-mt-2b',
        stream: true,
        temperature: 0,
        max_tokens: Math.max(1024, Math.min(16000, text.length * 3)),
        chat_template_kwargs: { enable_thinking: false },
        messages: [{
          role: 'user',
          content: (target === 'en'
            ? '请将以下文本翻译为英语。直接输出翻译结果，不要进行任何解释。\n\n'
            : '请将以下文本翻译为中文。直接输出翻译结果，不要进行任何解释。\n\n') + text
        }]
      };
    var options = {
      sourceText: text,
      onDelta: function (delta) {
        if (revision !== requestRevision || dismissed) return;
        queueOutput(delta, revision);
      },
      describeError: function (status) { return 'HTTP ' + status; }
    };
    if (controller) options.signal = controller.signal;

    window.ItTranslationStream.request('https://index-translate.bilibili.com/v1/chat/completions', payload, options)
      .then(function (result) {
        if (revision !== requestRevision || dismissed) return;
        if (paintFrame) cancelAnimationFrame(paintFrame);
        paintFrame = 0;
        flushOutputQueue(true, revision);
        output.textContent = result.text;
        copy.disabled = !result.text.trim();
      }).catch(function (error) {
        if (revision !== requestRevision || dismissed || error && error.name === 'AbortError') return;
        cancelOutputQueue();
        copy.disabled = true;
        var failure = document.createElement('span');
        failure.className = 'err';
        failure.textContent = '翻译失败：' + error.message;
        output.textContent = '';
        output.appendChild(failure);
      });
  };

  copy.addEventListener('click', async function () {
    if (copy.disabled || dismissed) return;
    var revision = requestRevision;
    var value = output.innerText || '';
    if (!value.trim() || output.querySelector('.ph, .err')) {
      copy.textContent = '没有可复制内容';
      clearTimeout(copyFeedbackTimer);
      copyFeedbackTimer = setTimeout(function () {
        if (revision === requestRevision && !dismissed) copy.textContent = '复制';
      }, 1600);
      return;
    }
    copy.disabled = true;
    try {
      var internals = window.__TAURI_INTERNALS__;
      if (window.__JIAN_DESKTOP__ && typeof window.__JIAN_DESKTOP__.invoke === 'function') {
        await window.__JIAN_DESKTOP__.invoke('it_write_clipboard_text', { text: value });
      } else if (internals && typeof internals.invoke === 'function') {
        await internals.invoke('it_write_clipboard_text', { text: value }, {});
      } else if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
        await window.__TAURI__.core.invoke('it_write_clipboard_text', { text: value });
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        throw new Error('剪贴板接口不可用');
      }
      if (revision !== requestRevision || dismissed) return;
      copy.textContent = '已复制';
    } catch (error) {
      if (revision !== requestRevision || dismissed) return;
      copy.textContent = '复制失败';
      copy.title = String(error && error.message || error || '无法写入系统剪贴板');
    } finally {
      if (revision !== requestRevision || dismissed) return;
      copy.disabled = false;
      clearTimeout(copyFeedbackTimer);
      copyFeedbackTimer = setTimeout(function () {
        if (revision !== requestRevision || dismissed) return;
        copy.textContent = '复制';
        copy.title = '';
      }, 1800);
    }
  });

  var activePopupPreferences = null;
  var activePopupBackgroundData = null;
  function popupSystemDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function popupMotionDisabled() {
    var motion = activePopupPreferences && activePopupPreferences.appearance &&
      activePopupPreferences.appearance.motion || 'system';
    return motion === 'off' || !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function applyPopupPreferences(preferences) {
    if (!preferences) return;
    var appearance = preferences.appearance || {};
    var background = preferences.background || {};
    var popup = preferences.popup || {};
    activePopupPreferences = preferences;
    var root = document.documentElement;
    var mode = appearance.mode || 'system';
    var dark = mode === 'dark' || (mode === 'system' && popupSystemDark());
    var palettes = {
      sakura: ['#E28BA6', '#C96F90', '#F0A8BE', '#E28BA6'],
      mist: ['#54AEB2', '#388D94', '#7DD0D0', '#54AEB2'],
      sage: ['#83A58B', '#66876F', '#A4C9A5', '#83A58B'],
      amber: ['#E3A253', '#C88733', '#F2BC72', '#E3A253']
    };
    var colors = palettes[appearance.palette] || palettes.sakura;
    var liquidGlass = window.ItLiquidGlass.normalize(preferences.liquidGlass);
    var scaleValue = Number(appearance.fontScale);
    var fontScale = Number.isFinite(scaleValue) ? Math.max(90, Math.min(140, scaleValue)) / 100 : 1;
    var radius = appearance.radius || 'round';
    var fontWeightValue = Number(appearance.fontWeight);
    var fontWeight = Number.isFinite(fontWeightValue)
      ? Math.max(300, Math.min(700, fontWeightValue)) : 400;
    var fontColor = appearance.fontColorMode === 'custom' &&
      /^#[0-9a-f]{6}$/i.test(appearance.fontColor || '')
      ? appearance.fontColor : (dark ? '#F1EEF5' : '#2E2A38');
    var customFont = typeof appearance.systemFontFamily === 'string'
      ? appearance.systemFontFamily.trim() : '';
    var genericFont = appearance.font === 'serif'
      ? 'ui-serif,"Noto Serif CJK SC",serif'
      : appearance.font === 'mono' ? 'ui-monospace,"Cascadia Mono",monospace'
        : '"PingFang SC","Microsoft YaHei UI","Noto Sans SC",system-ui,sans-serif';
    var fontFamily = customFont ? JSON.stringify(customFont) + ',' + genericFont : genericFont;
    var backgroundOpacityValue = Number(background.opacity);
    var backgroundOpacity = Number.isFinite(backgroundOpacityValue)
      ? Math.max(0, Math.min(80, backgroundOpacityValue)) / 100 : .34;
    var backgroundBlurValue = Number(background.blur);
    var backgroundBlur = Number.isFinite(backgroundBlurValue)
      ? Math.max(0, Math.min(20, backgroundBlurValue)) : 0;
    var backgroundFit = background.fit === 'contain' ? 'contain' : 'cover';
    var backgroundData = typeof popup.backgroundData === 'string' && popup.backgroundData
      ? popup.backgroundData : (typeof background.data === 'string' ? background.data : '');

    root.dataset.themeMode = mode;
    root.dataset.themeScheme = dark ? 'dark' : 'light';
    root.dataset.palette = appearance.palette || 'sakura';
    root.dataset.radius = radius;
    root.dataset.font = appearance.font || 'sans';
    root.dataset.motion = appearance.motion || 'system';
    root.dataset.layout = appearance.layout || 'standard';
    root.dataset.ambientLight = appearance.ambientLight === false ? 'false' : 'true';
    root.style.setProperty('--lg-accent', dark ? colors[2] : colors[0]);
    root.style.setProperty('--lg-accent-deep', dark ? colors[3] : colors[1]);
    root.style.setProperty('--lg-accent-wash', dark ? 'rgba(255,255,255,.12)' :
      'color-mix(in srgb, ' + colors[0] + ' 18%, transparent)');
    root.style.setProperty('--lg-ink', dark ? '#F1EEF5' : '#2E2A38');
    root.style.setProperty('--lg-ink-sub', dark ? '#C4BFCC' : '#6E687E');
    root.style.setProperty('--lg-ink-faint', dark ? '#96909F' : '#A29CAC');
    root.style.setProperty('--lg-edge', dark ? 'rgba(255,255,255,.18)' : 'rgba(70,52,96,.12)');
    root.style.setProperty('--lg-edge-dark', dark ? 'rgba(255,255,255,.12)' : 'rgba(70,52,96,.09)');
    root.style.setProperty('--lg-scrollbar-thumb', dark ? 'rgba(255,255,255,.28)' : 'rgba(70,52,96,.22)');
    root.style.setProperty('--lg-r-lg', (radius === 'small' ? 10 : radius === 'standard' ? 18 : 26) + 'px');
    window.ItLiquidGlass.configure(liquidGlass);
    window.ItLiquidGlass.refresh(document.getElementById('copy'));
    root.style.setProperty('--lg-control-radius', radius === 'small' ? '7px' : radius === 'standard' ? '10px' : '999px');
    root.style.setProperty('--user-font-scale', String(fontScale));
    root.style.setProperty('--it-popup-content-weight', String(fontWeight));
    root.style.setProperty('--it-popup-content-color', fontColor);
    root.style.setProperty('--it-popup-content-font', fontFamily);
    root.style.setProperty('--it-liquid-tint-rgb', dark ? '48 44 56' : '255 255 255');
    root.style.setProperty('--it-popup-bg-overlay', dark
      ? 'rgba(18,16,24,' + backgroundOpacity + ')'
      : 'rgba(255,255,255,' + backgroundOpacity + ')');
    root.style.setProperty('--it-popup-bg-blur', backgroundBlur + 'px');
    root.style.setProperty('--it-popup-bg-fit', backgroundFit);
    root.style.setProperty('--it-popup-bg-inset',
      (backgroundFit === 'contain' ? 0 : -2 * backgroundBlur) + 'px');
    if (backgroundData !== activePopupBackgroundData) {
      popupBackground.style.setProperty('--it-popup-background-image',
        backgroundData ? 'url("' + backgroundData + '")' : 'none');
      activePopupBackgroundData = backgroundData;
    }
  }

  window.__popupApplyPreferences = applyPopupPreferences;
  if (window.__itPopupAppearance) applyPopupPreferences(window.__itPopupAppearance);

  var colorSchemeQuery = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  if (colorSchemeQuery) {
    var onColorSchemeChange = function () {
      if (activePopupPreferences && activePopupPreferences.appearance &&
          activePopupPreferences.appearance.mode === 'system') {
        applyPopupPreferences(activePopupPreferences);
      }
    };
    if (colorSchemeQuery.addEventListener) colorSchemeQuery.addEventListener('change', onColorSchemeChange);
    else if (colorSchemeQuery.addListener) colorSchemeQuery.addListener(onColorSchemeChange);
  }
  window.__popupBooted = true;
  if (window.__itPopupPayload) window.__popupApply(window.__itPopupPayload);
  if (window.__itPopupPresentRequested) window.__popupPresent();
})();
})();
"#;

// ---------------------------------------------------------------------------
// 划词、快捷键、设置命令
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
struct SystemFontFamilies {
    names: Vec<String>,
    seen: std::collections::HashSet<String>,
}

fn is_local_app_origin(url: &tauri::Url) -> bool {
    let host = url.host_str().unwrap_or_default();
    url.port().is_none()
        && ((url.scheme() == "tauri" && host == "localhost")
            || (matches!(url.scheme(), "http" | "https") && host == "tauri.localhost"))
}

fn is_blank_popup_url(url: &tauri::Url) -> bool {
    url.as_str() == "about:blank"
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn collect_system_font_family(
    font: *const windows_sys::Win32::Graphics::Gdi::LOGFONTW,
    _metric: *const windows_sys::Win32::Graphics::Gdi::TEXTMETRICW,
    _font_type: u32,
    data: windows_sys::Win32::Foundation::LPARAM,
) -> i32 {
    if font.is_null() || data == 0 {
        return 1;
    }
    // SAFETY: GDI invokes this callback with a valid LOGFONTW and our live enumeration context.
    let font = unsafe { &*font };
    let end = font
        .lfFaceName
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(font.lfFaceName.len());
    if end == 0 {
        return 1;
    }

    let name = String::from_utf16_lossy(&font.lfFaceName[..end]);
    // SAFETY: LPARAM was passed from it_list_system_fonts while that stack value remains alive.
    let families = unsafe { &mut *(data as *mut SystemFontFamilies) };
    if families.seen.insert(name.to_lowercase()) {
        families.names.push(name);
    }
    1
}

#[tauri::command(async)]
pub fn it_list_system_fonts(window: WebviewWindow) -> Result<Vec<String>, String> {
    let url = window
        .url()
        .map_err(|error| format!("无法读取窗口地址：{error}"))?;
    if window.label() != APP_WINDOW_LABEL || !is_local_app_origin(&url) {
        return Err("系统字体列表仅允许应用设置窗口读取".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Graphics::Gdi::{
            EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET, LOGFONTW,
        };

        // SAFETY: GetDC accepts a null HWND to acquire the desktop DC.
        let hdc = unsafe { GetDC(std::ptr::null_mut()) };
        if hdc.is_null() {
            return Err("无法读取 Windows 系统字体".to_string());
        }

        let font = LOGFONTW {
            lfCharSet: DEFAULT_CHARSET,
            ..Default::default()
        };
        let mut families = SystemFontFamilies {
            names: Vec::new(),
            seen: std::collections::HashSet::new(),
        };
        // SAFETY: `hdc`, `font`, and the stack-backed callback context stay valid for the call.
        unsafe {
            EnumFontFamiliesExW(
                hdc,
                &font,
                Some(collect_system_font_family),
                &mut families as *mut SystemFontFamilies as isize,
                0,
            );
            let _ = ReleaseDC(std::ptr::null_mut(), hdc);
        }

        families.names.sort_by_key(|name| name.to_lowercase());
        if families.names.is_empty() {
            return Err("Windows 未返回可用字体".to_string());
        }
        Ok(families.names)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        Err("系统字体列表仅支持 Windows".to_string())
    }
}

#[cfg(target_os = "windows")]
fn read_clipboard_text() -> String {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

    // SAFETY: this scope owns the opened clipboard until CloseClipboard.
    unsafe {
        if IsClipboardFormatAvailable(CF_UNICODETEXT as u32) == 0 {
            return String::new();
        }
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return String::new();
        }
        let text = read_open_clipboard_text();
        let _ = CloseClipboard();
        text
    }
}

#[cfg(target_os = "windows")]
fn read_open_clipboard_text() -> String {
    use windows_sys::Win32::System::DataExchange::GetClipboardData;
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

    // SAFETY: callers hold the clipboard open; the borrowed HGLOBAL is never freed.
    unsafe {
        let handle = GetClipboardData(CF_UNICODETEXT as u32);
        let mut text = String::new();
        if !handle.is_null() {
            let bytes = GlobalSize(handle);
            // CF_UNICODETEXT owns a movable global allocation. Reject malformed
            // byte lengths, and never scan past either that allocation or our
            // input limit (including one unit reserved for the terminator).
            if bytes >= 2 && bytes % 2 == 0 {
                let pointer = GlobalLock(handle);
                if !pointer.is_null() {
                    let units = (bytes / std::mem::size_of::<u16>()).min(200_001);
                    let wide = std::slice::from_raw_parts(pointer as *const u16, units);
                    if let Some(length) = wide.iter().position(|unit| *unit == 0) {
                        text = String::from_utf16_lossy(&wide[..length]);
                    }
                    let _ = GlobalUnlock(handle);
                }
            }
        }
        text
    }
}

#[cfg(not(target_os = "windows"))]
fn read_clipboard_text() -> String {
    String::new()
}

const MAX_CLIPBOARD_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_CLIPBOARD_IMAGE_DIMENSION: i32 = 16_384;

fn clipboard_image_layout(width: i32, height: i32) -> Result<(usize, usize), String> {
    if width <= 0 || height <= 0 || width > MAX_CLIPBOARD_IMAGE_DIMENSION
        || height > MAX_CLIPBOARD_IMAGE_DIMENSION
    {
        return Err("剪贴板图片尺寸无效或过大".to_string());
    }
    let stride = (width as usize).checked_mul(3)
        .and_then(|bytes| bytes.checked_add(3))
        .map(|bytes| bytes & !3)
        .ok_or_else(|| "剪贴板图片尺寸过大".to_string())?;
    let length = stride.checked_mul(height as usize)
        .filter(|length| *length <= MAX_CLIPBOARD_IMAGE_BYTES - 54)
        .ok_or_else(|| "剪贴板图片过大，请缩小后重试".to_string())?;
    Ok((stride, length))
}

fn clipboard_image_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = ((chunk[0] as u32) << 16)
            | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
            | chunk.get(2).copied().unwrap_or(0) as u32;
        encoded.push(ALPHABET[((value >> 18) & 63) as usize] as char);
        encoded.push(ALPHABET[((value >> 12) & 63) as usize] as char);
        encoded.push(if chunk.len() > 1 { ALPHABET[((value >> 6) & 63) as usize] as char } else { '=' });
        encoded.push(if chunk.len() > 2 { ALPHABET[(value & 63) as usize] as char } else { '=' });
    }
    encoded
}

fn clipboard_bitmap_file(width: i32, height: i32, pixels: &[u8]) -> Result<Vec<u8>, String> {
    let (_, length) = clipboard_image_layout(width, height)?;
    if pixels.len() != length {
        return Err("剪贴板位图数据不完整".to_string());
    }
    let mut bmp = vec![0u8; 54];
    bmp[..2].copy_from_slice(b"BM");
    bmp[2..6].copy_from_slice(&((length + 54) as u32).to_le_bytes());
    bmp[10..14].copy_from_slice(&54u32.to_le_bytes());
    bmp[14..18].copy_from_slice(&40u32.to_le_bytes());
    bmp[18..22].copy_from_slice(&width.to_le_bytes());
    // A negative height matches the top-down pixels requested from GetDIBits.
    bmp[22..26].copy_from_slice(&(-height).to_le_bytes());
    bmp[26..28].copy_from_slice(&1u16.to_le_bytes());
    bmp[28..30].copy_from_slice(&24u16.to_le_bytes());
    bmp[34..38].copy_from_slice(&(length as u32).to_le_bytes());
    bmp.extend_from_slice(pixels);
    Ok(bmp)
}

fn clipboard_png_data_url(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() < 33 || bytes.len() > MAX_CLIPBOARD_IMAGE_BYTES
        || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes[8..12] != 13u32.to_be_bytes() || &bytes[12..16] != b"IHDR"
    {
        return Err("剪贴板 PNG 图片无效或过大".to_string());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width > i32::MAX as u32 || height > i32::MAX as u32 {
        return Err("剪贴板图片尺寸过大".to_string());
    }
    clipboard_image_layout(width as i32, height as i32)?;
    Ok(format!("data:image/png;base64,{}", clipboard_image_base64(bytes)))
}

#[cfg(target_os = "windows")]
fn read_open_clipboard_png(format: u32) -> Result<String, String> {
    use windows_sys::Win32::System::DataExchange::GetClipboardData;
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    // SAFETY: the caller owns the open clipboard. Only a bounded locked allocation is copied.
    unsafe {
        let handle = GetClipboardData(format);
        if handle.is_null() { return Err("无法读取剪贴板图片".to_string()); }
        let length = GlobalSize(handle);
        if length == 0 || length > MAX_CLIPBOARD_IMAGE_BYTES {
            return Err("剪贴板图片为空或过大".to_string());
        }
        let pointer = GlobalLock(handle);
        if pointer.is_null() { return Err("无法读取剪贴板图片".to_string()); }
        let bytes = std::slice::from_raw_parts(pointer as *const u8, length).to_vec();
        let _ = GlobalUnlock(handle);
        clipboard_png_data_url(&bytes)
    }
}

#[cfg(target_os = "windows")]
fn read_open_clipboard_bitmap() -> Result<String, String> {
    use windows_sys::Win32::Graphics::Gdi::{
        GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BI_RGB, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::System::DataExchange::GetClipboardData;
    use windows_sys::Win32::System::Ole::CF_BITMAP;
    // SAFETY: the caller holds the clipboard open. The returned HBITMAP is borrowed;
    // Windows owns it, so it must not be selected into a DC or deleted here.
    unsafe {
        let bitmap = GetClipboardData(CF_BITMAP as u32);
        if bitmap.is_null() { return Err("无法读取剪贴板位图".to_string()); }
        let mut details: BITMAP = std::mem::zeroed();
        if GetObjectW(bitmap, std::mem::size_of::<BITMAP>() as i32, &mut details as *mut _ as _) == 0 {
            return Err("无法读取剪贴板位图尺寸".to_string());
        }
        let (_, length) = clipboard_image_layout(details.bmWidth, details.bmHeight)?;
        let mut pixels = vec![0u8; length];
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of_val(&info.bmiHeader) as u32;
        info.bmiHeader.biWidth = details.bmWidth;
        info.bmiHeader.biHeight = -details.bmHeight;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 24;
        info.bmiHeader.biCompression = BI_RGB;
        info.bmiHeader.biSizeImage = length as u32;
        let dc = GetDC(std::ptr::null_mut());
        if dc.is_null() { return Err("无法转换剪贴板位图".to_string()); }
        let lines = GetDIBits(dc, bitmap, 0, details.bmHeight as u32,
            pixels.as_mut_ptr() as _, &mut info, DIB_RGB_COLORS);
        let _ = ReleaseDC(std::ptr::null_mut(), dc);
        if lines != details.bmHeight { return Err("剪贴板位图数据不完整".to_string()); }
        let bmp = clipboard_bitmap_file(details.bmWidth, details.bmHeight, &pixels)?;
        Ok(format!("data:image/bmp;base64,{}", clipboard_image_base64(&bmp)))
    }
}

#[cfg(target_os = "windows")]
fn read_clipboard_content() -> Result<serde_json::Value, String> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW,
    };
    use windows_sys::Win32::System::Ole::{CF_BITMAP, CF_DIB, CF_DIBV5};
    struct OpenClipboardGuard;
    impl Drop for OpenClipboardGuard {
        fn drop(&mut self) {
            // SAFETY: this guard is created only after successfully opening the clipboard.
            unsafe { CloseClipboard(); }
        }
    }
    // SAFETY: the guard releases this thread's clipboard access on every return path.
    unsafe {
        let opened = (0..8).any(|_| {
            if OpenClipboard(std::ptr::null_mut()) != 0 { true }
            else { std::thread::sleep(Duration::from_millis(12)); false }
        });
        if !opened { return Err("系统剪贴板正被占用，请重试".to_string()); }
        let _guard = OpenClipboardGuard;
        let png_format = RegisterClipboardFormatW([80u16, 78, 71, 0].as_ptr());
        let png = if png_format != 0 && IsClipboardFormatAvailable(png_format) != 0 {
            Some(read_open_clipboard_png(png_format))
        } else { None };
        if let Some(Ok(image)) = png.as_ref() {
            return Ok(serde_json::json!({ "text": "", "image": image }));
        }
        // Windows synthesizes CF_BITMAP from the standard DIB/DIBV5 clipboard formats.
        if [CF_BITMAP, CF_DIB, CF_DIBV5].into_iter()
            .any(|format| IsClipboardFormatAvailable(format as u32) != 0)
        {
            return read_open_clipboard_bitmap()
                .map(|image| serde_json::json!({ "text": "", "image": image }));
        }
        if let Some(Err(error)) = png { return Err(error); }
        Ok(serde_json::json!({ "text": read_open_clipboard_text(), "image": "" }))
    }
}

#[cfg(not(target_os = "windows"))]
fn read_clipboard_content() -> Result<serde_json::Value, String> {
    Err("当前桌面平台不支持剪贴板读取".to_string())
}

#[tauri::command(async)]
pub fn it_write_clipboard_text(window: WebviewWindow, text: String) -> Result<(), String> {
    let url = window
        .url()
        .map_err(|error| format!("无法读取悬浮窗地址：{error}"))?;
    if !is_translate_app(window.app_handle())
        || window.label() != POPUP_LABEL
        || !is_blank_popup_url(&url)
    {
        return Err("剪贴板写入仅允许悬浮窗调用".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::GlobalFree;
        use windows_sys::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
        };
        use windows_sys::Win32::System::Memory::{
            GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
        };
        use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

        let _transaction = CLIPBOARD_TRANSACTION
            .lock()
            .map_err(|_| "剪贴板操作暂时不可用".to_string())?;
        let hwnd = window
            .hwnd()
            .map_err(|error| format!("无法获取窗口句柄：{error}"))?;
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes = wide.len() * std::mem::size_of::<u16>();
        // SAFETY: A movable global allocation is required by SetClipboardData(CF_UNICODETEXT).
        let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes) };
        if memory.is_null() {
            return Err("分配剪贴板文本内存失败".to_string());
        }

        // SAFETY: `memory` is a valid allocation returned by GlobalAlloc above.
        let pointer = unsafe { GlobalLock(memory) } as *mut u16;
        if pointer.is_null() {
            unsafe { GlobalFree(memory) };
            return Err("锁定剪贴板文本内存失败".to_string());
        }
        // SAFETY: The allocation is locked and has room for every UTF-16 code unit plus NUL.
        unsafe {
            std::ptr::copy_nonoverlapping(wide.as_ptr(), pointer, wide.len());
            let _ = GlobalUnlock(memory);
        }

        let opened = (0..8).any(|_| {
            // SAFETY: The invoking popup HWND remains alive for the duration of this command.
            if unsafe { OpenClipboard(hwnd.0 as _) } != 0 {
                true
            } else {
                std::thread::sleep(Duration::from_millis(12));
                false
            }
        });
        if !opened {
            unsafe { GlobalFree(memory) };
            return Err("系统剪贴板正被占用".to_string());
        }

        // SAFETY: This command owns the opened clipboard until CloseClipboard below.
        let emptied = unsafe { EmptyClipboard() } != 0;
        let transferred =
            emptied && !unsafe { SetClipboardData(CF_UNICODETEXT as u32, memory) }.is_null();
        unsafe { CloseClipboard() };
        if !emptied {
            unsafe { GlobalFree(memory) };
            return Err("清空系统剪贴板失败".to_string());
        }
        if !transferred {
            unsafe { GlobalFree(memory) };
            return Err("写入系统剪贴板失败".to_string());
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, text);
        Err("系统剪贴板命令仅支持 Windows".to_string())
    }
}

#[cfg(target_os = "windows")]
fn clipboard_sequence() -> u32 {
    use windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber;
    unsafe { GetClipboardSequenceNumber() }
}

#[cfg(not(target_os = "windows"))]
fn clipboard_sequence() -> u32 {
    0
}

/// 热键触发的瞬间修饰键还按着（用户设的 Alt+Q，默认是 Ctrl+Alt+T）。
/// 这时候模拟 Ctrl+C，目标程序收到的是 Ctrl+Alt+C，根本不会复制——
/// 这是「按快捷键只弹主窗口、不翻译」的根因。
#[cfg(target_os = "windows")]
fn pressed_modifiers() -> Vec<u16> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN]
        .into_iter()
        .filter(|vk| (unsafe { GetAsyncKeyState(*vk as i32) } as u16 & 0x8000) != 0)
        .collect()
}

/// 兜底：用户一直按着热键时，主动发一次修饰键 keyup，把按键状态清干净。
#[cfg(target_os = "windows")]
fn release_stuck_modifiers() {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        keybd_event, KEYEVENTF_KEYUP, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    unsafe {
        for vk in [VK_LWIN, VK_RWIN, VK_MENU, VK_CONTROL, VK_SHIFT] {
            keybd_event(vk as u8, 0, KEYEVENTF_KEYUP, 0);
        }
    }
}

#[cfg(target_os = "windows")]
fn wait_hotkey_release() {
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(500) {
        if pressed_modifiers().is_empty() {
            // 再给目标程序一点时间处理 keyup / 退出 Alt 菜单态
            std::thread::sleep(Duration::from_millis(35));
            return;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
    release_stuck_modifiers();
    std::thread::sleep(Duration::from_millis(40));
}

#[cfg(not(target_os = "windows"))]
fn wait_hotkey_release() {}

#[cfg(target_os = "windows")]
fn send_copy_shortcut() {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        keybd_event, KEYEVENTF_KEYUP, VK_C, VK_CONTROL,
    };
    unsafe {
        keybd_event(VK_CONTROL as u8, 0, 0, 0);
        keybd_event(VK_C as u8, 0, 0, 0);
        std::thread::sleep(Duration::from_millis(60));
        keybd_event(VK_C as u8, 0, KEYEVENTF_KEYUP, 0);
        keybd_event(VK_CONTROL as u8, 0, KEYEVENTF_KEYUP, 0);
    }
}

/// 读当前选中文本：等热键松开 → 记下剪贴板 → 模拟 Ctrl+C → 读变化。
/// 只有剪贴板序号/内容真的变了才算取到，绝不拿旧剪贴板内容去误翻译。
/// 全程纯 Win32，不起子进程（外部命令会被安全策略拦截）。
#[cfg(target_os = "windows")]
fn capture_selection(generation: u64) -> String {
    wait_hotkey_release();
    let Ok(_transaction) = CLIPBOARD_TRANSACTION.lock() else {
        return String::new();
    };
    if !popup_request_is_current(generation) {
        return String::new();
    }
    let before = read_clipboard_text();
    let sequence = clipboard_sequence();
    send_copy_shortcut();

    for _ in 0..24 {
        std::thread::sleep(Duration::from_millis(50));
        if !popup_request_is_current(generation) {
            return String::new();
        }
        let current = read_clipboard_text();
        if current.trim().is_empty() {
            continue;
        }
        if clipboard_sequence() != sequence || current != before {
            return current;
        }
    }
    String::new()
}

#[cfg(not(target_os = "windows"))]
fn capture_selection(_generation: u64) -> String {
    String::new()
}

fn hide_popup(app: &AppHandle) {
    if let Some(popup) = app.get_webview_window(POPUP_LABEL) {
        let _ = popup.eval("window.__popupDismiss&&window.__popupDismiss()");
        let _ = popup.hide();
    }
}

#[cfg(target_os = "windows")]
fn popup_is_foreground(app: &AppHandle) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    app.get_webview_window(POPUP_LABEL)
        .and_then(|window| window.hwnd().ok())
        // SAFETY: GetForegroundWindow returns a borrowed handle; it is only compared.
        .is_some_and(|hwnd| unsafe { GetForegroundWindow() } == hwnd.0)
}

#[cfg(not(target_os = "windows"))]
fn popup_is_foreground(_app: &AppHandle) -> bool {
    false
}

fn run_selection_translate(
    app: AppHandle,
    init_fullscreen: bool,
    startup_revealed: Arc<AtomicBool>,
) {
    let settings = current_settings();
    let open_main_window = settings.open_main_window;
    let id = POPUP_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let generation = next_popup_generation();
    let restore_source = popup_is_foreground(&app);
    // Only a previously focused popup needs to yield focus back to the source.
    // The new pending window is shown without activation before capture begins.
    if restore_source || open_main_window {
        hide_popup(&app);
    }

    let capture_app = app.clone();
    let capture = move || {
        std::thread::spawn(move || {
            if restore_source {
                std::thread::sleep(Duration::from_millis(90));
            }
            if !popup_request_is_current(generation) {
                return;
            }
            let text = capture_selection(generation);
            if !popup_request_is_current(generation) {
                return;
            }

            if text.trim().is_empty() {
                let notice = "没有取到选中文字。请先选中文本再按快捷键；部分软件不支持自动复制。";
                if open_main_window {
                    let notice_app = capture_app.clone();
                    let target = settings.target_lang.clone();
                    present_popup(
                        &capture_app,
                        id,
                        generation,
                        &settings.target_lang,
                        move || {
                            complete_popup(&notice_app, id, generation, "", notice, &target);
                        },
                    );
                } else {
                    complete_popup(
                        &capture_app,
                        id,
                        generation,
                        "",
                        notice,
                        &settings.target_lang,
                    );
                }
                return;
            }

            if open_main_window {
                cancel_startup_reveal(&startup_revealed);
                show_all_app_windows(&capture_app, init_fullscreen);
                // show_all_app_windows 会把所有 webview 都 show 出来（含悬浮窗），
                // 稍后把悬浮窗重新藏好，避免主窗口模式冒出一个透明空窗。
                let app_for_hide = capture_app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(220));
                    if popup_request_is_current(generation) {
                        hide_popup(&app_for_hide);
                    }
                });
                if let Some(window) = capture_app.get_webview_window(APP_WINDOW_LABEL) {
                    let _ = window.set_focus();
                    let json = serde_json::to_string(&text).unwrap_or_else(|_| "\"\"".to_string());
                    let eval = format!(
                        "(function(t,id){{ \
                     if(String(window.__itSelectionAccepted)===String(id))return; \
                     if(typeof window.__itTranslateSelection==='function') \
                     {{ window.__itTranslateSelection(t,id); }} \
                     else {{ window.__itPendingSelection={{text:t,id:id}}; }} }})({json},{id})"
                    );
                    // Only an unacknowledged/not-yet-ready page can consume a
                    // retry. The frontend acknowledges before editing or I/O.
                    for delay in [0u64, 250, 700, 1500] {
                        let window = window.clone();
                        let eval = eval.clone();
                        std::thread::spawn(move || {
                            if delay > 0 {
                                std::thread::sleep(Duration::from_millis(delay));
                            }
                            if popup_request_is_current(generation) {
                                let _ = window.eval(&eval);
                            }
                        });
                    }
                }
            } else {
                complete_popup(
                    &capture_app,
                    id,
                    generation,
                    &text,
                    "",
                    &settings.target_lang,
                );
            }
        });
    };
    if open_main_window {
        capture();
    } else {
        let target = current_settings().target_lang;
        present_popup(&app, id, generation, &target, capture);
    }
}

fn run_clipboard_translate(app: AppHandle, startup_revealed: Arc<AtomicBool>) {
    cancel_startup_reveal(&startup_revealed);
    let generation = next_popup_generation();
    let id = POPUP_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    hide_popup(&app);
    let show_app = app.clone();
    let _ = app.run_on_main_thread(move || {
        if !popup_request_is_current(generation) {
            return;
        }
        if let Some(window) = show_app.get_webview_window(APP_WINDOW_LABEL) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            let _ = window.eval(&format!(
                "(function(id){{ if(typeof window.__itBeginClipboardTranslation==='function') \
                 window.__itBeginClipboardTranslation(id); else window.__itPendingClipboardStart=id; }})({id})"
            ));
            read_clipboard_for_translation(show_app, id, generation);
        }
    });
}

fn read_clipboard_for_translation(app: AppHandle, id: u64, generation: u64) {
    std::thread::spawn(move || {
        if !popup_request_is_current(generation) {
            return;
        }
        let content = CLIPBOARD_TRANSACTION.lock()
            .map_err(|_| "剪贴板读取暂时不可用，请重试".to_string())
            .and_then(|_transaction| read_clipboard_content())
            .unwrap_or_else(|error| serde_json::json!({ "error": error }));
        if !popup_request_is_current(generation) {
            return;
        }
        let payload = content.to_string();
        let script = format!(
            "(function(payload,id){{ \
             if(String(window.__itClipboardTranslationAccepted)===String(id))return; \
             if(typeof window.__itTranslateClipboard==='function') \
             {{ window.__itTranslateClipboard(payload,id); }} \
             else {{ payload.id=id;payload.kind='clipboard';window.__itPendingSelection=payload; }} }})({payload},{id})"
        );
        let script = Arc::new(script);
        let callback_app = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(window) = callback_app.get_webview_window(APP_WINDOW_LABEL) {
                for delay in [0u64, 250, 700, 1500] {
                    let window = window.clone();
                    let script = script.clone();
                    std::thread::spawn(move || {
                        if delay > 0 {
                            std::thread::sleep(Duration::from_millis(delay));
                        }
                        if popup_request_is_current(generation) {
                            let _ = window.eval(&script);
                        }
                    });
                }
            }
        });
    });
}

#[tauri::command]
pub fn it_get_settings() -> DesktopSettings {
    current_settings()
}

#[tauri::command]
pub fn it_set_hotkeys_enabled(enabled: bool) {
    HOTKEYS_ENABLED.store(enabled, Ordering::Relaxed);
}

/// Development-only bounded diagnostics; the release command is a no-op.
#[tauri::command(async)]
pub fn it_debug_log(message: String) {
    #[cfg(debug_assertions)]
    {
        use std::io::Write;
        static LOG_LOCK: Mutex<()> = Mutex::new(());
        let Ok(_guard) = LOG_LOCK.lock() else { return; };
        let path = std::env::temp_dir().join("it-titlebar.log");
        let rotate = fs::metadata(&path).map(|metadata| metadata.len() >= 262_144).unwrap_or(false);
        if rotate {
            // Keep one bounded previous log and truncate the active file.
            let _ = fs::copy(&path, path.with_extension("previous.log"));
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(!rotate)
            .truncate(rotate)
            .open(path)
        {
            let bounded: String = message.chars().take(1024)
                .filter(|character| !character.is_control()).collect();
            let _ = writeln!(file, "{bounded}");
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = message;
}

fn rollback_settings_changes(
    app: &AppHandle,
    previous: &DesktopSettings,
    attempted: &DesktopSettings,
    hotkeys_changed: bool,
) -> Vec<String> {
    let mut errors = Vec::new();
    if hotkeys_changed {
        unregister_shortcuts(app, attempted);
        errors.extend(register_shortcuts(app, previous));
    }
    errors
}

// 同步命令会在 WebView 的 IPC 线程（Windows 上是主线程）里执行，
// 内部又要调全局快捷键插件与注册表，容易把消息循环堵住、前端收不到返回。
// 用 command(async) 让它在阻塞线程池里跑。
#[tauri::command(async)]
pub fn it_save_settings(app: AppHandle, settings: DesktopSettings) -> Result<Vec<String>, String> {
    let activation = settings.activation_shortcut.trim();
    let selection = settings.selection_shortcut.trim();
    let clipboard = settings.clipboard_shortcut.trim();
    if !activation.is_empty() && parse_shortcut(activation).is_none() {
        return Err(format!("无法识别快捷键「{activation}」"));
    }
    if selection.is_empty() || parse_shortcut(selection).is_none() {
        return Err(format!("无法识别快捷键「{selection}」"));
    }
    if clipboard.is_empty() || parse_shortcut(clipboard).is_none() {
        return Err(format!("无法识别快捷键「{clipboard}」"));
    }
    let shortcuts = [activation, selection, clipboard]
        .into_iter()
        .filter(|shortcut| !shortcut.is_empty())
        .filter_map(|shortcut| Shortcut::from_str(shortcut).ok())
        .collect::<Vec<_>>();
    if shortcuts.iter().enumerate().any(|(index, shortcut)| shortcuts[..index].contains(shortcut)) {
        return Err("桌面快捷键不能重复".to_string());
    }

    let previous = current_settings();

    let next = DesktopSettings {
        activation_shortcut: activation.to_string(),
        selection_shortcut: selection.to_string(),
        clipboard_shortcut: clipboard.to_string(),
        open_main_window: settings.open_main_window,
        target_lang: if settings.target_lang.is_empty() {
            "auto".to_string()
        } else {
            settings.target_lang.clone()
        },
        // The system startup target is managed by it_set_autostart. Keep the
        // legacy JSON field unchanged for compatibility with older settings.
        auto_start: previous.auto_start,
        start_to_tray: settings.start_to_tray,
        preferences: settings.preferences,
    };

    let hotkeys_changed = next.activation_shortcut != previous.activation_shortcut
        || next.selection_shortcut != previous.selection_shortcut
        || next.clipboard_shortcut != previous.clipboard_shortcut;
    if hotkeys_changed {
        unregister_shortcuts(&app, &previous);
        let errors = register_shortcuts(&app, &next);
        if !errors.is_empty() {
            let rollback = rollback_settings_changes(&app, &previous, &next, true);
            let detail = if rollback.is_empty() {
                String::new()
            } else {
                format!("；{}", rollback.join("；"))
            };
            return Err(format!("{}{}", errors.join("；"), detail));
        }
    }

    if let Err(error) = persist_settings(&app, &next) {
        let rollback = rollback_settings_changes(&app, &previous, &next, hotkeys_changed);
        let detail = if rollback.is_empty() {
            String::new()
        } else {
            format!("；{}", rollback.join("；"))
        };
        return Err(format!("{error}{detail}"));
    }

    store_settings(next.clone());
    sync_popup_appearance(&app, &next);
    Ok(Vec::new())
}

pub fn set_system_tray(
    app: &AppHandle,
    show_system_tray: bool,
    tray_icon_path: &str,
    _init_fullscreen: bool,
    allow_multi_window: bool,
    startup_revealed: Arc<AtomicBool>,
) -> tauri::Result<()> {
    if !show_system_tray {
        app.remove_tray_by_id("pake-tray");
        return Ok(());
    }

    let labels = TrayLabels::for_language(UiLanguage::system());
    let new_window = MenuItemBuilder::with_id("tray_new_window", labels.new_window).build(app)?;
    let hide_app = MenuItemBuilder::with_id("hide_app", labels.hide).build(app)?;
    let show_app = MenuItemBuilder::with_id("show_app", labels.show).build(app)?;
    let translate =
        MenuItemBuilder::with_id("tray_translate_selection", labels.translate).build(app)?;
    let settings = MenuItemBuilder::with_id("tray_settings", labels.settings).build(app)?;
    let quit = MenuItemBuilder::with_id("quit", labels.quit).build(app)?;

    let enhanced = is_translate_app(app);
    let menu = if allow_multi_window {
        let mut builder = MenuBuilder::new(app);
        builder = builder.items(&[&new_window, &hide_app, &show_app]);
        if enhanced {
            builder = builder.items(&[&translate, &settings]);
        }
        builder.item(&quit).build()?
    } else {
        let mut builder = MenuBuilder::new(app);
        builder = builder.items(&[&hide_app, &show_app]);
        if enhanced {
            builder = builder.items(&[&translate, &settings]);
        }
        builder.item(&quit).build()?
    };

    app.app_handle().remove_tray_by_id("pake-tray");

    let menu_revealed = startup_revealed.clone();
    let click_revealed = startup_revealed;
    let mut tray_builder = TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "tray_new_window" => {
                open_additional_window_safe(app);
            }
            "hide_app" => {
                cancel_startup_reveal(&menu_revealed);
                hide_all_app_windows(app);
            }
            "show_app" => {
                cancel_startup_reveal(&menu_revealed);
                show_all_app_windows(app, _init_fullscreen);
            }
            "tray_translate_selection" => {
                run_selection_translate(
                    (*app).clone(),
                    _init_fullscreen,
                    menu_revealed.clone(),
                );
            }
            "tray_settings" => {
                cancel_startup_reveal(&menu_revealed);
                show_all_app_windows(app, _init_fullscreen);
                if let Some(window) = app.get_webview_window(APP_WINDOW_LABEL) {
                    let _ = window.set_focus();
                    let _ = window.eval(
                        "setTimeout(function(){window.__itOpenSettings&&window.__itOpenSettings();},120)",
                    );
                }
            }
            "quit" => {
                let flags = if _init_fullscreen {
                    StateFlags::all()
                } else {
                    StateFlags::all() & !StateFlags::FULLSCREEN
                };
                let _ = app.save_window_state(flags);
                app.exit(0);
            }
            _ => (),
        })
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state,
                ..
            } = event
            {
                if button == MouseButton::Left && button_state == MouseButtonState::Up {
                    cancel_startup_reveal(&click_revealed);
                    toggle_all_app_windows(tray.app_handle(), _init_fullscreen);
                }
            }
        });

    let resolved_icon = if tray_icon_path.is_empty() {
        app.default_window_icon().cloned()
    } else {
        tauri::image::Image::from_path(tray_icon_path)
            .ok()
            .or_else(|| app.default_window_icon().cloned())
    };

    if let Some(icon) = resolved_icon {
        tray_builder = tray_builder.icon(icon);
    } else {
        eprintln!("[Pake] No tray icon available; tray will build without an icon.");
    }

    let tray = tray_builder.build(app)?;

    tray.set_icon_as_template(false)?;
    Ok(())
}

pub fn set_global_shortcut(
    app: &AppHandle,
    shortcut: String,
    _init_fullscreen: bool,
    startup_revealed: Arc<AtomicBool>,
) -> tauri::Result<()> {
    let enhanced = is_translate_app(app);
    if enhanced {
        // Prepare the hidden document early; arrival animation starts only on
        // __popupPresent, so warming does not consume its visible fade.
        let warm_app = app.clone();
        std::thread::spawn(move || {
            if let Some(popup) = ensure_popup(&warm_app) {
                let _ = popup.eval(&popup_appearance_script(&popup_appearance(
                    &current_settings(),
                )));
            }
        });
        // 隐藏系统边框，标题栏由页面自绘；窗口动作走 it_window_action 命令
        if let Some(window) = app.get_webview_window(APP_WINDOW_LABEL) {
            remove_main_window_top_frame_inset(&window);
            if let Err(error) = window.set_decorations(false) {
                eprintln!("[IT] 隐藏系统边框失败：{error}");
            }
            apply_window_border(&window);

            let border_window = window.clone();
            window.on_window_event(move |event| {
                if matches!(
                    event,
                    tauri::WindowEvent::Focused(_) | tauri::WindowEvent::ThemeChanged(_)
                ) {
                    apply_window_border(&border_window);
                }
            });
        }
        // 覆盖层是窗口创建后才挂上的，延迟几次确保能抓到
        let handle = app.clone();
        std::thread::spawn(move || {
            for _ in 0..6 {
                std::thread::sleep(Duration::from_millis(250));
                make_drag_overlay_click_through(&handle);
            }
        });
    }
    let mut settings = load_settings(app, &shortcut);
    if !enhanced {
        // 其它 Pake 应用保持原行为：只注册 CLI 传入的显示快捷键
        settings.selection_shortcut.clear();
        settings.clipboard_shortcut.clear();
        settings.activation_shortcut = shortcut;
    }
    store_settings(settings.clone());

    if settings.activation_shortcut.trim().is_empty()
        && settings.selection_shortcut.trim().is_empty()
        && settings.clipboard_shortcut.trim().is_empty()
    {
        return Ok(());
    }

    let app_handle = app.clone();
    let last_triggered = Arc::new(Mutex::new(None::<Instant>));

    if let Err(error) = app_handle.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler({
                let last_triggered = Arc::clone(&last_triggered);
                move |app, event, shortcut_event| {
                    if shortcut_event.state() != ShortcutState::Pressed
                        || !HOTKEYS_ENABLED.load(Ordering::Relaxed) {
                        return;
                    }
                    let Ok(mut last_triggered) = last_triggered.lock() else {
                        return;
                    };
                    if last_triggered.is_some_and(|last| last.elapsed() < Duration::from_millis(320)) {
                        return;
                    }
                    *last_triggered = Some(Instant::now());

                    let settings = current_settings();
                    if let Some(hotkey) = parse_shortcut(&settings.selection_shortcut) {
                        if hotkey.eq(event) {
                            cancel_startup_reveal(&startup_revealed);
                            run_selection_translate(
                                (*app).clone(),
                                _init_fullscreen,
                                startup_revealed.clone(),
                            );
                            return;
                        }
                    }
                    if let Some(hotkey) = parse_shortcut(&settings.activation_shortcut) {
                        if hotkey.eq(event) {
                            cancel_startup_reveal(&startup_revealed);
                            toggle_all_app_windows(app, _init_fullscreen);
                            return;
                        }
                    }
                    if let Some(hotkey) = parse_shortcut(&settings.clipboard_shortcut) {
                        if hotkey.eq(event) {
                            run_clipboard_translate((*app).clone(), startup_revealed.clone());
                        }
                    }
                }
            })
            .build(),
    ) {
        eprintln!(
            "[Pake] Failed to register global shortcut plugin: {error}; continuing without it."
        );
        return Ok(());
    }

    for message in register_shortcuts(app, &settings) {
        eprintln!("[IT] {message}");
    }

    Ok(())
}

#[cfg(test)]
mod local_origin_tests {
    use super::{is_blank_popup_url, is_local_app_origin};
    use tauri::Url;

    #[test]
    fn accepts_tauri_local_origins() {
        for origin in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/index.html",
        ] {
            let url = Url::parse(origin).expect("test URL should parse");
            assert!(is_local_app_origin(&url), "expected local origin: {origin}");
        }
    }

    #[test]
    fn rejects_remote_and_non_app_origins() {
        for origin in [
            "https://example.com/",
            "tauri://example.com/",
            "https://tauri.localhost.example.com/",
            "http://localhost:5173/",
            "http://tauri.localhost:5173/",
            "file:///index.html",
        ] {
            let url = Url::parse(origin).expect("test URL should parse");
            assert!(
                !is_local_app_origin(&url),
                "expected non-app origin: {origin}"
            );
        }
    }

    #[test]
    fn only_allows_the_blank_popup_document_for_clipboard_access() {
        for (address, expected) in [
            ("about:blank", true),
            ("https://example.com/", false),
            ("tauri://localhost/index.html", false),
        ] {
            let url = Url::parse(address).expect("test URL should parse");
            assert_eq!(
                is_blank_popup_url(&url),
                expected,
                "unexpected popup document acceptance: {address}"
            );
        }
    }
}
