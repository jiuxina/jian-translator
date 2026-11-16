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
use std::path::PathBuf;
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
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

#[cfg(target_os = "windows")]
use tauri_runtime::ResizeDirection;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "IndexTranslate";

const DEFAULT_SELECTION_SHORTCUT: &str = "Ctrl+Alt+T";
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
    pub open_main_window: bool,
    pub target_lang: String,
    pub auto_start: bool,
    /// 启动时直接藏进托盘、不弹主窗口。默认开启，可在设置面板关闭。
    pub start_to_tray: bool,
    /// 前端偏好由前端校验；桌面只负责可靠持久化和投影外观到划词浮窗。
    pub preferences: serde_json::Value,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            selection_shortcut: DEFAULT_SELECTION_SHORTCUT.to_string(),
            activation_shortcut: "Ctrl+Alt+I".to_string(),
            open_main_window: false,
            target_lang: "auto".to_string(),
            auto_start: false,
            start_to_tray: true,
            preferences: serde_json::Value::Null,
        }
    }
}

static SETTINGS: Mutex<Option<DesktopSettings>> = Mutex::new(None);
static HOTKEYS_ENABLED: AtomicBool = AtomicBool::new(true);
static CLIPBOARD_TRANSACTION: Mutex<()> = Mutex::new(());
// 每次唤起悬浮窗换一个 id，JS 用它给重复投递的脚本去重
static POPUP_SEQ: AtomicU64 = AtomicU64::new(0);
// watchdog 代次：新翻译顶掉旧 watchdog，避免多个线程同时盯一个窗口
static POPUP_GENERATION: AtomicU64 = AtomicU64::new(0);

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
    let saved = settings_file(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<DesktopSettings>(&text).ok());

    let mut settings = saved.unwrap_or_default();
    if settings.selection_shortcut.trim().is_empty() {
        settings.selection_shortcut = DEFAULT_SELECTION_SHORTCUT.to_string();
    }
    if settings.activation_shortcut.trim().is_empty() && !cli_activation.is_empty() {
        settings.activation_shortcut = cli_activation.to_string();
    }
    if settings.target_lang.is_empty() {
        settings.target_lang = "auto".to_string();
    }
    settings
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
        NCCALCSIZE_PARAMS, WM_DISPLAYCHANGE, WM_DPICHANGED, WM_DWMCOMPOSITIONCHANGED,
        WM_NCCALCSIZE, WM_NCDESTROY, WM_SIZE, WM_WINDOWPOSCHANGED,
    };

    if message == WM_NCCALCSIZE && wparam != 0 && lparam != 0 {
        // SAFETY: Windows supplies a live NCCALCSIZE_PARAMS for WM_NCCALCSIZE with wParam set.
        let params = unsafe { &mut *(lparam as *mut NCCALCSIZE_PARAMS) };
        let proposed_top = params.rgrc[0].top;
        let result = DefSubclassProc(hwnd, message, wparam, lparam);
        let added_top_inset = proposed_top - params.rgrc[0].top;
        if (1..=8).contains(&added_top_inset) {
            params.rgrc[0].top = proposed_top;
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
fn open_run_key() -> Option<windows_sys::Win32::System::Registry::HKEY> {
    use windows_sys::Win32::System::Registry::{
        RegOpenKeyExW, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE,
    };
    let subkey = wide(RUN_KEY);
    let mut key: windows_sys::Win32::System::Registry::HKEY = std::ptr::null_mut();
    let result = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            KEY_QUERY_VALUE | KEY_SET_VALUE,
            &mut key,
        )
    };
    if result == 0 {
        Some(key)
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn autostart_enabled() -> bool {
    use windows_sys::Win32::System::Registry::{RegCloseKey, RegQueryValueExW};
    let Some(key) = open_run_key() else {
        return false;
    };
    let name = wide(RUN_VALUE);
    let mut size: u32 = 0;
    let mut kind: u32 = 0;
    let result = unsafe {
        RegQueryValueExW(
            key,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            std::ptr::null_mut(),
            &mut size,
        )
    };
    unsafe {
        RegCloseKey(key);
    }
    result == 0 && size > 0
}

#[cfg(not(target_os = "windows"))]
fn autostart_enabled() -> bool {
    false
}

#[cfg(target_os = "windows")]
fn apply_autostart(enabled: bool) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegSetValueExW, REG_SZ,
    };
    let key = open_run_key().ok_or_else(|| "无法打开启动项注册表键".to_string())?;
    let name = wide(RUN_VALUE);

    let result = if enabled {
        let executable =
            std::env::current_exe().map_err(|error| format!("取不到程序路径：{error}"))?;
        let value = wide(&format!("\"{}\"", executable.display()));
        let data: Vec<u8> = value.iter().flat_map(|unit| unit.to_le_bytes()).collect();
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
        unsafe { RegDeleteValueW(key, name.as_ptr()) }
    };
    unsafe {
        RegCloseKey(key);
    }
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
        "(function(){{var p={payload};window.__itPopupPayload=p;\
         if(window.__popupApply)window.__popupApply(p);}})();"
    )
}

/// 模板 + 数据一起投递：WebView 还没建好时 eval 会丢，Rust 侧会重复调本函数，
/// JS 用 payload.id 去重，不会重复发翻译请求。
fn deliver_popup(window: &WebviewWindow, payload: &str, appearance: &serde_json::Value) {
    let _ = window.eval(LIQUID_GLASS_ENGINE);
    let _ = window.eval(POPUP_BOOTSTRAP);
    let _ = window.eval(&popup_appearance_script(appearance));
    let _ = window.eval(&popup_payload_script(payload));
}

/// notice 非空时只显示提示，不发翻译请求。
fn show_popup(app: &AppHandle, text: &str, notice: &str) {
    let settings = current_settings();
    let appearance = popup_appearance(&settings);
    let id = POPUP_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let payload = serde_json::json!({
        "id": id,
        "text": text,
        "notice": notice,
        "target": settings.target_lang,
    })
    .to_string();
    let generation = POPUP_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;

    // 建窗口 / show / eval 全部放主线程：从后台线程 build 只是排队，
    // 紧接着的 eval 很容易打在还没创建出来的 WebView 上，表现是「窗口空白不翻译」。
    let handle = app.clone();
    let main_thread_app = handle.clone();
    let _ = handle.run_on_main_thread(move || {
        let Some(window) = ensure_popup(&main_thread_app) else {
            return;
        };
        deliver_popup(&window, &payload, &appearance);
        position_popup(&main_thread_app, &window);
        let _ = window.show();
        let _ = window.set_focus();

        for delay in [150u64, 450, 1000, 2000] {
            let window = window.clone();
            let payload = payload.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(delay));
                let appearance = popup_appearance(&current_settings());
                deliver_popup(&window, &payload, &appearance);
            });
        }
        watch_popup(main_thread_app.clone(), window, generation);
    });
}

fn ensure_popup(app: &AppHandle) -> Option<WebviewWindow> {
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
                let _ = window.eval(POPUP_BOOTSTRAP);
            }
        });

    builder.build().ok().map(|window| {
        // about:blank 不一定触发 PageLoadEvent，创建后立即注入模板；
        // show_popup 还会带数据重复投递几次，模板内部有幂等判断。
        let _ = window.eval(LIQUID_GLASS_ENGINE);
        let _ = window.eval(POPUP_BOOTSTRAP);
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

fn watch_popup(app: AppHandle, window: WebviewWindow, generation: u64) {
    std::thread::spawn(move || {
        let _ = &app; // 只有非 Windows 分支用得到，避免告警
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
                break;
            }
            // 长时间没被聚焦（系统限制了后台抢焦点）就自动收起，避免一直挂着
            if !seen_foreground && ticks > 90 {
                let _ = window.destroy();
                break;
            }

            #[cfg(target_os = "windows")]
            {
                use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
                use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

                let foreground = unsafe { GetForegroundWindow() };
                let mine = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
                let is_me = foreground as isize == mine;
                if is_me {
                    seen_foreground = true;
                } else if seen_foreground && ticks % 2 == 0 {
                    // 再确认一次，避免焦点切换瞬间误关
                    std::thread::sleep(Duration::from_millis(120));
                    let again = unsafe { GetForegroundWindow() };
                    if again as isize != mine {
                        let _ = window.destroy();
                        break;
                    }
                }

                // 低位表示「上次查询后按下过」，能捕获很快的 Esc 轻点
                let esc = unsafe { GetAsyncKeyState(0x1B) } as u16 & 0x8001 != 0;
                if esc {
                    let _ = window.destroy();
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

const POPUP_BOOTSTRAP: &str = r#"
(function () {
if (window.__popupBooted && window.__popupApply && document.getElementById('out')) {
  if (window.__itPopupAppearance && window.__popupApplyPreferences) {
    window.__popupApplyPreferences(window.__itPopupAppearance);
  }
  if (window.__itPopupPayload) window.__popupApply(window.__itPopupPayload);
  return;
}
document.documentElement.innerHTML = `
<head><meta charset="utf-8"><style>
  /* 主题排版由悬浮窗内联；液态玻璃滤镜与主界面共用 ItLiquidGlass。 */
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
    -webkit-font-smoothing:antialiased;}
  body{box-sizing:border-box;padding:22px;position:relative;isolation:isolate;}
  #card-frame{height:100%;position:relative;isolation:isolate;border-radius:var(--lg-r-lg);
    box-shadow:var(--lg-shadow-strong);
    transform-origin:center;animation:popup-arrive var(--lg-duration-panel) var(--lg-ease-enter) both;}
  #popup-background{position:absolute;z-index:0;inset:0;overflow:hidden;border-radius:inherit;pointer-events:none;}
  #popup-background::before{content:"";position:absolute;inset:var(--it-popup-bg-inset);
    background-image:var(--it-popup-background-image,none);background-position:center;background-repeat:no-repeat;
    background-size:var(--it-popup-bg-fit);filter:blur(var(--it-popup-bg-blur));}
  #popup-background::after{content:"";position:absolute;inset:0;
    background:var(--it-popup-bg-overlay);}
  #card{box-sizing:border-box;height:100%;display:flex;flex-direction:column;
    position:relative;z-index:1;isolation:isolate;overflow:hidden;
    background:transparent;
    border:0;border-radius:var(--lg-r-lg);
    -webkit-backdrop-filter:none;backdrop-filter:none;}
  #card>*:not([data-it-liquid-background]):not([data-it-liquid-progressive]){position:relative;z-index:1;}
  [data-it-liquid-preset]{position:relative;isolation:isolate;}
  [data-it-liquid-background],[data-it-liquid-progressive]{position:absolute;inset:0;z-index:-1;
    border-radius:inherit;pointer-events:none;}
  [data-it-liquid-background]{background:rgb(var(--it-liquid-tint-rgb) / var(--it-liquid-background-opacity,0));
    -webkit-backdrop-filter:var(--it-liquid-filter,none);backdrop-filter:var(--it-liquid-filter,none);}
  [data-it-liquid-progressive]{overflow:hidden;}
  [data-it-liquid-progressive]>span{position:absolute;inset:0;border-radius:inherit;pointer-events:none;}
  .head{display:flex;align-items:center;justify-content:space-between;gap:8px;
    padding:10px 14px 8px;font-size:11.5px;color:var(--lg-ink-sub);}
  .head b{font-weight:600;color:var(--lg-accent-deep);}
  .body{flex:1;overflow-y:auto;padding:2px 14px 12px;font-size:calc(14px * var(--user-font-scale));line-height:1.8;
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
  .ph{color:var(--lg-ink-faint);font-size:13px;}
  .err{color:var(--lg-accent-deep);font-size:13px;}
  .foot{display:flex;align-items:center;justify-content:space-between;
    padding:8px 12px 9px;border-top:1px solid var(--lg-edge-dark);font-size:11px;color:var(--lg-ink-faint);}
  .foot button{border:1px solid var(--lg-edge);background:transparent;
    -webkit-backdrop-filter:none;backdrop-filter:none;
    color:var(--lg-accent-deep);border-radius:999px;
    padding:5px 12px;font-size:11.5px;cursor:pointer;
    transition:background var(--lg-duration-control),color var(--lg-duration-control);}
  .foot button:hover{border-color:var(--lg-accent);color:var(--lg-ink);}
  #glass-status{margin:0;padding:0 14px 4px;font-size:10px;color:var(--lg-accent-deep);}
  #glass-status[hidden]{display:none;}
  :root[data-it-liquid-glass="unsupported"] #card{background:transparent;}
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
window.ItLiquidGlass.attach(document.getElementById('card'), 'card');
window.ItLiquidGlass.attach(document.getElementById('copy'), 'button');

(function () {
  var output = document.getElementById('out');
  var meta = document.getElementById('meta');
  var badge = document.getElementById('badge');
  var copy = document.getElementById('copy');
  var popupBackground = document.getElementById('popup-background');
  var copyFeedbackTimer = 0;
  var lastId = 0;
  var controller = null;
  var paintQueue = '';
  var paintFrame = 0;

  function cancelOutputQueue() {
    if (paintFrame) cancelAnimationFrame(paintFrame);
    paintFrame = 0;
    paintQueue = '';
  }

  function flushOutputQueue(final) {
    paintFrame = 0;
    if (!paintQueue) return;
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
    if (paintQueue) paintFrame = requestAnimationFrame(function () { flushOutputQueue(false); });
  }

  function queueOutput(text) {
    if (output.querySelector('.ph')) output.textContent = '';
    if (popupMotionDisabled()) {
      output.appendChild(document.createTextNode(text));
      return;
    }
    paintQueue += text;
    if (!paintFrame) paintFrame = requestAnimationFrame(function () { flushOutputQueue(false); });
  }

  function pickTarget(text, wanted) {
    if (wanted === 'zh' || wanted === 'en') return wanted;
    return /[\u4e00-\u9fa5]/.test(text) ? 'en' : 'zh';
  }

  window.__popupApply = function (p) {
    if (!p || p.id === lastId) return;   // 重复投递不去重就会重复发请求
    lastId = p.id;
    cancelOutputQueue();
    if (controller) { try { controller.abort(); } catch (e) {} controller = null; }

    var notice = (p && p.notice) || '';
    copy.textContent = '复制';
    if (notice) {
      meta.textContent = '提示';
      badge.textContent = '';
      output.textContent = notice;
      return;
    }

    var text = (p && p.text) || '';
    var target = pickTarget(text, p && p.target);
    meta.textContent = text.length > 42 ? text.slice(0, 42) + '…' : text;
    badge.textContent = target === 'en' ? '→ EN' : '→ 中文';
    output.innerHTML = '<span class="ph">正在翻译…</span>';

    var accumulated = '';
    controller = typeof AbortController === 'function' ? new AbortController() : null;
    var options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'index-mt-2b',
        stream: true,
        temperature: 0,
        max_tokens: 1024,
        chat_template_kwargs: { enable_thinking: false },
        messages: [{
          role: 'user',
          content: (target === 'en'
            ? '请将以下文本翻译为英语。直接输出翻译结果，不要进行任何解释。\n\n'
            : '请将以下文本翻译为中文。直接输出翻译结果，不要进行任何解释。\n\n') + text
        }]
      })
    };
    if (controller) options.signal = controller.signal;

    fetch('https://index-translate.bilibili.com/v1/chat/completions', options)
      .then(async function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        while (true) {
          var read = await reader.read();
          if (read.done) break;
          buffer += decoder.decode(read.value, { stream: true });
          var parts = buffer.split('\n\n');
          buffer = parts.pop();
          for (var i = 0; i < parts.length; i++) {
            var line = parts[i].trim();
            if (line.indexOf('data:') !== 0) continue;
            var data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              var json = JSON.parse(data);
              var delta = json.choices && json.choices[0] && json.choices[0].delta;
              if (delta && delta.content) {
                accumulated += delta.content;
                queueOutput(delta.content);
              }
            } catch (e) {}
          }
        }
        if (paintFrame) cancelAnimationFrame(paintFrame);
        paintFrame = 0;
        flushOutputQueue(true);
        if (!accumulated) output.innerHTML = '<span class="ph">没有拿到译文</span>';
      }).catch(function (error) {
        if (error && error.name === 'AbortError') return;
        cancelOutputQueue();
        output.innerHTML = '<span class="err">翻译失败：' + error.message + '</span>';
      });
  };

  copy.addEventListener('click', async function () {
    var value = output.innerText || '';
    if (!value.trim()) {
      copy.textContent = '没有可复制内容';
      clearTimeout(copyFeedbackTimer);
      copyFeedbackTimer = setTimeout(function () { copy.textContent = '复制'; }, 1600);
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
      copy.textContent = '已复制';
    } catch (error) {
      copy.textContent = '复制失败';
      copy.title = String(error && error.message || error || '无法写入系统剪贴板');
    } finally {
      copy.disabled = false;
      clearTimeout(copyFeedbackTimer);
      copyFeedbackTimer = setTimeout(function () {
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
    window.ItLiquidGlass.refresh(document.getElementById('card'));
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
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

    unsafe {
        if IsClipboardFormatAvailable(CF_UNICODETEXT as u32) == 0 {
            return String::new();
        }
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return String::new();
        }
        let handle = GetClipboardData(CF_UNICODETEXT as u32);
        let mut text = String::new();
        if !handle.is_null() {
            let pointer = GlobalLock(handle);
            if !pointer.is_null() {
                let wide = pointer as *const u16;
                let mut length = 0usize;
                while *wide.add(length) != 0 && length < 200_000 {
                    length += 1;
                }
                text = String::from_utf16_lossy(std::slice::from_raw_parts(wide, length));
                let _ = GlobalUnlock(handle);
            }
        }
        let _ = CloseClipboard();
        text
    }
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
fn capture_selection() -> String {
    wait_hotkey_release();
    let Ok(_transaction) = CLIPBOARD_TRANSACTION.lock() else {
        return String::new();
    };
    let before = read_clipboard_text();
    let sequence = clipboard_sequence();
    send_copy_shortcut();

    for _ in 0..24 {
        std::thread::sleep(Duration::from_millis(50));
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
fn capture_selection() -> String {
    String::new()
}

fn hide_popup(app: &AppHandle) {
    if let Some(popup) = app.get_webview_window(POPUP_LABEL) {
        let _ = popup.hide();
    }
}

fn run_selection_translate(
    app: AppHandle,
    init_fullscreen: bool,
    startup_revealed: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        // 上一次的悬浮窗如果还开着，它可能正处在前台；先藏起来，
        // 否则模拟的 Ctrl+C 会打进悬浮窗而不是用户正在看的窗口。
        hide_popup(&app);
        std::thread::sleep(Duration::from_millis(90));

        let text = capture_selection();
        let settings = current_settings();

        if text.trim().is_empty() {
            // 没取到选中文字：只给悬浮窗提示。
            // 旧的兜底会 show_all_app_windows()，表现就是「按快捷键弹主窗口、不翻译」。
            show_popup(
                &app,
                "",
                "没有取到选中文字。请先选中文本再按快捷键；部分软件不支持自动复制。",
            );
            return;
        }

        if settings.open_main_window {
            cancel_startup_reveal(&startup_revealed);
            show_all_app_windows(&app, init_fullscreen);
            // show_all_app_windows 会把所有 webview 都 show 出来（含悬浮窗），
            // 稍后把悬浮窗重新藏好，避免主窗口模式冒出一个透明空窗。
            let app_for_hide = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(220));
                hide_popup(&app_for_hide);
            });
            if let Some(window) = app.get_webview_window(APP_WINDOW_LABEL) {
                let _ = window.set_focus();
                let json = serde_json::to_string(&text).unwrap_or_else(|_| "\"\"".to_string());
                let eval = format!(
                    "(function(t){{ if (typeof window.__itTranslateSelection === 'function') \
                     {{ window.__itTranslateSelection(t); }} \
                     else {{ window.__itPendingSelection = t; }} }})({json})"
                );
                // 主窗口刚被唤起 / 页面还没加载完时，单次 eval 会丢，补投几次
                for delay in [0u64, 250, 700, 1500] {
                    let window = window.clone();
                    let eval = eval.clone();
                    std::thread::spawn(move || {
                        if delay > 0 {
                            std::thread::sleep(Duration::from_millis(delay));
                        }
                        let _ = window.eval(&eval);
                    });
                }
            }
        } else {
            show_popup(&app, &text, "");
        }
    });
}

#[tauri::command]
pub fn it_get_settings() -> DesktopSettings {
    let mut settings = current_settings();
    // 注册表是唯一事实来源，避免设置文件与系统状态不一致
    settings.auto_start = autostart_enabled();
    settings
}

#[tauri::command]
pub fn it_set_hotkeys_enabled(enabled: bool) {
    HOTKEYS_ENABLED.store(enabled, Ordering::Relaxed);
}

/// 临时诊断：把前端事件写到 %TEMP%\it-titlebar.log，验证自绘标题栏的点击链路。
#[tauri::command(async)]
pub fn it_debug_log(message: String) {
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("it-titlebar.log"))
    {
        let _ = writeln!(file, "{message}");
    }
}

fn rollback_settings_changes(
    app: &AppHandle,
    previous: &DesktopSettings,
    attempted: &DesktopSettings,
    hotkeys_changed: bool,
    auto_start_changed: bool,
) -> Vec<String> {
    let mut errors = Vec::new();
    if auto_start_changed {
        if let Err(error) = apply_autostart(previous.auto_start) {
            errors.push(format!("恢复开机自启状态失败：{error}"));
        }
    }
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
    if !activation.is_empty() && parse_shortcut(activation).is_none() {
        return Err(format!("无法识别快捷键「{activation}」"));
    }
    if selection.is_empty() || parse_shortcut(selection).is_none() {
        return Err(format!("无法识别快捷键「{selection}」"));
    }

    let previous = current_settings();

    let next = DesktopSettings {
        activation_shortcut: activation.to_string(),
        selection_shortcut: selection.to_string(),
        open_main_window: settings.open_main_window,
        target_lang: if settings.target_lang.is_empty() {
            "auto".to_string()
        } else {
            settings.target_lang.clone()
        },
        auto_start: settings.auto_start,
        start_to_tray: settings.start_to_tray,
        preferences: settings.preferences,
    };

    let hotkeys_changed = next.activation_shortcut != previous.activation_shortcut
        || next.selection_shortcut != previous.selection_shortcut;
    let auto_start_changed = next.auto_start != previous.auto_start;

    if hotkeys_changed {
        unregister_shortcuts(&app, &previous);
        let errors = register_shortcuts(&app, &next);
        if !errors.is_empty() {
            let rollback = rollback_settings_changes(&app, &previous, &next, true, false);
            let detail = if rollback.is_empty() {
                String::new()
            } else {
                format!("；{}", rollback.join("；"))
            };
            return Err(format!("{}{}", errors.join("；"), detail));
        }
    }

    if auto_start_changed {
        if let Err(error) = apply_autostart(next.auto_start) {
            let rollback = rollback_settings_changes(&app, &previous, &next, hotkeys_changed, true);
            let detail = if rollback.is_empty() {
                String::new()
            } else {
                format!("；{}", rollback.join("；"))
            };
            return Err(format!("{error}{detail}"));
        }
    }

    if let Err(error) = persist_settings(&app, &next) {
        let rollback =
            rollback_settings_changes(&app, &previous, &next, hotkeys_changed, auto_start_changed);
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
        settings.activation_shortcut = shortcut;
    }
    store_settings(settings.clone());

    if settings.activation_shortcut.trim().is_empty()
        && settings.selection_shortcut.trim().is_empty()
    {
        return Ok(());
    }

    let app_handle = app.clone();
    let last_triggered = Arc::new(Mutex::new(Instant::now()));

    if let Err(error) = app_handle.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler({
                let last_triggered = Arc::clone(&last_triggered);
                move |app, event, _shortcut| {
                    if !HOTKEYS_ENABLED.load(Ordering::Relaxed) {
                        return;
                    }
                    let Ok(mut last_triggered) = last_triggered.lock() else {
                        return;
                    };
                    if Instant::now().duration_since(*last_triggered) < Duration::from_millis(320) {
                        return;
                    }
                    *last_triggered = Instant::now();

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
