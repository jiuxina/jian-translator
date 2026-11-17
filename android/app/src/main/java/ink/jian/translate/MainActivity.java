package ink.jian.translate;

import android.app.Activity;
import android.app.Dialog;
import android.content.res.Configuration;
import android.content.res.ColorStateList;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.graphics.Insets;
import androidx.core.view.OnApplyWindowInsetsListener;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.exifinterface.media.ExifInterface;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 「笺」Android 壳（v2 自绘前端）。
 *
 * 与 v1 的区别：不再加载官网页面、不再注入 CSS/JS。界面由 assets/ 下的
 * web 前端（与本仓库 web/ 目录同源，构建时同步）自己绘制，翻译请求直连官方
 * 公开接口 https://index-translate.bilibili.com/v1/chat/completions。
 *
 * 原生侧只负责 WebView 容器、相机/相册、系统栏安全区和返回键。
 */
public class MainActivity extends Activity {

    private static final String TAG = "IndexTranslate";

    private static final int REQ_CAMERA = 1003;
    private static final int REQ_GALLERY = 1005;
    private static final int REQ_CAMERA_PERM = 1004;

    private static final String ASSET_URL = "file:///android_asset/index.html";
    private static final String APPEARANCE_PREFS = "native_appearance";
    private static final String APPEARANCE_SNAPSHOT_KEY = "snapshot";

    private static final NativeAppearance DEFAULT_APPEARANCE = new NativeAppearance(
            false,
            new int[]{0xFFFCF8FB, 0xFFF3EFF6, 0xFFEBE5F4},
            0xFF2E2A38,
            0xFF6E687E,
            0xFFC96F90,
            0xAAFFFFFF,
            0x9EFFFFFF,
            0x24FFFFFF,
            0x33C96F90);

    private FrameLayout root;
    private WebView webView;
    private LinearLayout overlay;
    private ProgressBar spinner;
    private TextView overlayText;
    private Button retryButton;
    private PhotoSourceDialog photoSourceDialog;
    private NativeAppearance appearance = DEFAULT_APPEARANCE;
    private LinearLayout photoSourceSheet;
    private View photoSourceHandle;
    private TextView photoSourceTitle;
    private TextView photoSourceTakePhoto;
    private TextView photoSourceChoosePhoto;

    private boolean pageLoaded = false;
    private final ExecutorService imageIo = Executors.newSingleThreadExecutor();
    private Future<?> imageTask;
    private int imageRequestSequence;
    private String imageCallbackToken;

    // ------------------------------------------------------------------
    // 生命周期
    // ------------------------------------------------------------------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        appearance = loadAppearanceSnapshot();
        // The keyboard overlays the page. Resizing or panning the WebView
        // would squeeze both translation cards and rebuild their controls.
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING);
        // This root owns every system-bar inset. Older DecorViews must not
        // reserve the navigation bar before applyInsets handles it once.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            Window window = getWindow();
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
            window.getDecorView().setSystemUiVisibility(mainWindowSystemUiFlags());
        }

        root = new FrameLayout(this);
        root.setBackground(ambientBackground());
        setContentView(root);

        buildWebView();
        buildOverlay();
        applyInsets();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(ASSET_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        notifySystemAppearance();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        notifySystemAppearance();
    }

    @Override
    protected void onDestroy() {
        cancelImageTask();
        imageIo.shutdownNow();
        if (photoSourceDialog != null) {
            photoSourceDialog.dismissImmediately();
        }
        if (webView != null) {
            root.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------------
    // WebView
    // ------------------------------------------------------------------

    private void buildWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(Color.TRANSPARENT);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        // 本地页面需要跨域调用官方 API（服务端已返回 Access-Control-Allow-Origin: *）
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.addJavascriptInterface(new NativeBridge(), "NativeBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) return false;
                String scheme = uri.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    if (uri.toString().startsWith("file://")) return false;
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception ignored) {
                    }
                    return true;
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageLoaded = true;
                hideOverlay();
                notifySystemAppearance();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showOverlay("页面加载失败", true);
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                return true;
            }
        });

        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void applyInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(root, new OnApplyWindowInsetsListener() {
            @Override
            public WindowInsetsCompat onApplyWindowInsets(View v, WindowInsetsCompat insets) {
                int safeAreaTypes = WindowInsetsCompat.Type.systemBars()
                        | WindowInsetsCompat.Type.displayCutout();
                Insets safeArea = insets.getInsetsIgnoringVisibility(safeAreaTypes);
                if (webView != null) {
                    // WebView padding does not constrain fixed-position HTML controls.
                    // Only persistent system chrome constrains the viewport.
                    // IME visibility and height must not change the page's layout.
                    FrameLayout.LayoutParams params =
                            (FrameLayout.LayoutParams) webView.getLayoutParams();
                    if (params.leftMargin != safeArea.left || params.topMargin != safeArea.top
                            || params.rightMargin != safeArea.right
                            || params.bottomMargin != safeArea.bottom) {
                        params.setMargins(safeArea.left, safeArea.top, safeArea.right, safeArea.bottom);
                        webView.setLayoutParams(params);
                    }
                }
                // The native frame owns system chrome. Consume the keyboard's
                // inset as well so WebView does not shrink its content a second time.
                return new WindowInsetsCompat.Builder(insets)
                        .setInsets(safeAreaTypes | WindowInsetsCompat.Type.ime(), Insets.NONE).build();
            }
        });
        ViewCompat.requestApplyInsets(root);
    }

    // ------------------------------------------------------------------
    // 加载 / 错误浮层
    // ------------------------------------------------------------------

    private void buildOverlay() {
        overlay = new LinearLayout(this);
        overlay.setOrientation(LinearLayout.VERTICAL);
        overlay.setGravity(Gravity.CENTER);
        overlay.setBackground(ambientBackground());
        overlay.setClickable(true);

        spinner = new ProgressBar(this);
        spinner.setIndeterminateTintList(ColorStateList.valueOf(appearance.accent));
        LinearLayout.LayoutParams spinnerLp = new LinearLayout.LayoutParams(
                dp(28), dp(28));
        overlay.addView(spinner, spinnerLp);

        overlayText = new TextView(this);
        overlayText.setText("正在准备…");
        overlayText.setTextColor(appearance.mutedInk);
        overlayText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        LinearLayout.LayoutParams textLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        textLp.topMargin = dp(14);
        overlay.addView(overlayText, textLp);

        retryButton = new Button(this);
        retryButton.setText("重新加载");
        retryButton.setAllCaps(false);
        retryButton.setTextColor(Color.WHITE);
        retryButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        retryButton.setVisibility(View.GONE);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(appearance.accent);
        bg.setCornerRadius(dp(999));
        retryButton.setBackground(bg);
        retryButton.setPadding(dp(22), dp(8), dp(22), dp(8));
        LinearLayout.LayoutParams btnLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        btnLp.topMargin = dp(18);
        overlay.addView(retryButton, btnLp);

        retryButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showOverlay("正在准备…", false);
                webView.loadUrl(ASSET_URL);
            }
        });

        root.addView(overlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private GradientDrawable ambientBackground() {
        return new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                appearance.background);
    }

    private int systemUiFlags() {
        int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN;
        if (!appearance.dark) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        return flags;
    }

    private int mainWindowSystemUiFlags() {
        return systemUiFlags() | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
    }

    private void applyNativeAppearance(NativeAppearance next) {
        appearance = next;
        if (root != null) root.setBackground(ambientBackground());
        if (overlay != null) {
            overlay.setBackground(ambientBackground());
            overlayText.setTextColor(appearance.mutedInk);
            spinner.setIndeterminateTintList(ColorStateList.valueOf(appearance.accent));
            GradientDrawable retryBackground = new GradientDrawable();
            retryBackground.setColor(appearance.accent);
            retryBackground.setCornerRadius(dp(999));
            retryButton.setBackground(retryBackground);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            getWindow().getDecorView().setSystemUiVisibility(mainWindowSystemUiFlags());
        }
        applyPhotoSourceAppearance();
    }

    private void applyPhotoSourceAppearance() {
        if (photoSourceSheet == null) return;
        GradientDrawable surface = new GradientDrawable();
        surface.setColor(appearance.surface);
        surface.setCornerRadius(dp(24));
        surface.setStroke(dp(1), appearance.edge);
        photoSourceSheet.setBackground(surface);
        if (photoSourceHandle != null) {
            GradientDrawable handle = new GradientDrawable();
            handle.setColor((appearance.mutedInk & 0x00FFFFFF) | 0x55000000);
            handle.setCornerRadius(dp(2));
            photoSourceHandle.setBackground(handle);
        }
        if (photoSourceTitle != null) photoSourceTitle.setTextColor(appearance.ink);
        updatePhotoSourceAction(photoSourceTakePhoto);
        updatePhotoSourceAction(photoSourceChoosePhoto);
        if (photoSourceDialog != null && photoSourceDialog.getWindow() != null) {
            photoSourceDialog.getWindow().getDecorView().setSystemUiVisibility(systemUiFlags());
        }
    }

    private void updatePhotoSourceAction(TextView action) {
        if (action == null) return;
        action.setTextColor(appearance.mutedInk);
        GradientDrawable fill = new GradientDrawable();
        fill.setColor(appearance.controlFill);
        fill.setCornerRadius(dp(14));
        GradientDrawable mask = new GradientDrawable();
        mask.setColor(Color.WHITE);
        mask.setCornerRadius(dp(14));
        action.setBackground(new RippleDrawable(
                ColorStateList.valueOf(appearance.ripple), fill, mask));
    }

    private void notifySystemAppearance() {
        if (webView == null || !pageLoaded) return;
        String mode = getSystemAppearance();
        webView.evaluateJavascript("window.__itOnSystemAppearance&&window.__itOnSystemAppearance('"
                + mode + "')", null);
    }

    private String getSystemAppearance() {
        int night = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return night == Configuration.UI_MODE_NIGHT_YES ? "dark" : "light";
    }

    private static final class NativeAppearance {
        final boolean dark;
        final int[] background;
        final int ink;
        final int mutedInk;
        final int accent;
        final int surface;
        final int edge;
        final int controlFill;
        final int ripple;

        NativeAppearance(boolean dark, int[] background, int ink, int mutedInk, int accent,
                         int surface, int edge, int controlFill, int ripple) {
            this.dark = dark;
            this.background = background;
            this.ink = ink;
            this.mutedInk = mutedInk;
            this.accent = accent;
            this.surface = surface;
            this.edge = edge;
            this.controlFill = controlFill;
            this.ripple = ripple;
        }

        static NativeAppearance fromJson(String json) throws JSONException {
            JSONObject value = new JSONObject(json);
            JSONArray colors = value.getJSONArray("background");
            if (colors.length() != 3) throw new JSONException("background requires 3 colors");
            return new NativeAppearance(
                    value.getBoolean("dark"),
                    new int[]{color(colors.getString(0)), color(colors.getString(1)),
                            color(colors.getString(2))},
                    color(value.getString("ink")),
                    color(value.getString("mutedInk")),
                    color(value.getString("accent")),
                    color(value.getString("surface")),
                    color(value.getString("edge")),
                    color(value.getString("controlFill")),
                    color(value.getString("ripple")));
        }

        JSONObject toJson() throws JSONException {
            JSONArray colors = new JSONArray();
            for (int color : background) colors.put(colorString(color));
            return new JSONObject()
                    .put("dark", dark)
                    .put("background", colors)
                    .put("ink", colorString(ink))
                    .put("mutedInk", colorString(mutedInk))
                    .put("accent", colorString(accent))
                    .put("surface", colorString(surface))
                    .put("edge", colorString(edge))
                    .put("controlFill", colorString(controlFill))
                    .put("ripple", colorString(ripple));
        }

        private static String colorString(int color) {
            return String.format(Locale.ROOT, "#%08X", color);
        }

        private static int color(String value) throws JSONException {
            try {
                if (value == null || !value.matches("#[0-9a-fA-F]{8}")) {
                    throw new IllegalArgumentException("Expected #AARRGGBB color");
                }
                return Color.parseColor(value);
            } catch (IllegalArgumentException error) {
                throw new JSONException("Invalid appearance color");
            }
        }
    }

    private void applyNativeAppearanceJson(String json) {
        try {
            NativeAppearance next = NativeAppearance.fromJson(json);
            runOnUiThread(() -> applyNativeAppearance(next));
        } catch (JSONException | RuntimeException error) {
            Log.w(TAG, "Ignoring invalid native appearance update", error);
        }
    }

    private NativeAppearance loadAppearanceSnapshot() {
        String snapshotJson = getSharedPreferences(APPEARANCE_PREFS, MODE_PRIVATE)
                .getString(APPEARANCE_SNAPSHOT_KEY, null);
        if (snapshotJson == null) return DEFAULT_APPEARANCE;
        try {
            AppearanceSnapshot snapshot = AppearanceSnapshot.fromJson(snapshotJson);
            boolean systemDark = "dark".equals(getSystemAppearance());
            return snapshot.resolve(systemDark);
        } catch (JSONException | RuntimeException error) {
            Log.w(TAG, "Ignoring invalid cached native appearance", error);
            return DEFAULT_APPEARANCE;
        }
    }

    private boolean commitAppearanceSnapshot(String snapshotJson) {
        try {
            AppearanceSnapshot snapshot = AppearanceSnapshot.fromJson(snapshotJson);
            return getSharedPreferences(APPEARANCE_PREFS, MODE_PRIVATE).edit()
                    .putString(APPEARANCE_SNAPSHOT_KEY, snapshot.toJson().toString())
                    .commit();
        } catch (JSONException | RuntimeException error) {
            Log.w(TAG, "Ignoring invalid native appearance snapshot", error);
            return false;
        }
    }

    private static final class AppearanceSnapshot {
        final String mode;
        final NativeAppearance light;
        final NativeAppearance dark;

        AppearanceSnapshot(String mode, NativeAppearance light, NativeAppearance dark) {
            this.mode = mode;
            this.light = light;
            this.dark = dark;
        }

        static AppearanceSnapshot fromJson(String json) throws JSONException {
            JSONObject value = new JSONObject(json);
            String mode = value.getString("mode");
            if (!"system".equals(mode) && !"light".equals(mode) && !"dark".equals(mode)) {
                throw new JSONException("Invalid appearance mode");
            }
            NativeAppearance light = NativeAppearance.fromJson(value.getJSONObject("light").toString());
            NativeAppearance dark = NativeAppearance.fromJson(value.getJSONObject("dark").toString());
            if (light.dark || !dark.dark) throw new JSONException("Mismatched appearance projection");
            return new AppearanceSnapshot(mode, light, dark);
        }

        NativeAppearance resolve(boolean systemDark) {
            if ("dark".equals(mode)) return dark;
            if ("system".equals(mode) && systemDark) return dark;
            return light;
        }

        JSONObject toJson() throws JSONException {
            return new JSONObject()
                    .put("mode", mode)
                    .put("light", light.toJson())
                    .put("dark", dark.toJson());
        }
    }

    private void showOverlay(String message, boolean withRetry) {
        if (overlay == null) return;
        overlay.animate().cancel();
        boolean entering = overlay.getVisibility() != View.VISIBLE;
        if (entering) {
            overlay.setAlpha(0f);
            overlay.setVisibility(View.VISIBLE);
        } else {
            overlay.setAlpha(1f);
        }
        overlayText.setText(message);
        spinner.setVisibility(withRetry ? View.GONE : View.VISIBLE);
        retryButton.setVisibility(withRetry ? View.VISIBLE : View.GONE);
        if (entering) {
            overlay.animate().alpha(1f).setDuration(UiMotion.duration(this, UiMotion.DIALOG_MS))
                    .setInterpolator(UiMotion.enter()).start();
        }
    }

    private void hideOverlay() {
        if (overlay == null || overlay.getVisibility() != View.VISIBLE) return;
        overlay.animate().cancel();
        overlay.animate().alpha(0f).setDuration(UiMotion.duration(this, UiMotion.CONTROL_MS))
                .setInterpolator(UiMotion.standard())
                .withEndAction(() -> {
                    if (overlay != null && overlay.getAlpha() == 0f) {
                        overlay.setVisibility(View.GONE);
                    }
                }).start();
    }

    // ------------------------------------------------------------------
    // JS 桥
    // ------------------------------------------------------------------

    public class NativeBridge {
        @JavascriptInterface
        public String platform() {
            return "android";
        }

        @JavascriptInterface
        public String getSystemAppearance() {
            return MainActivity.this.getSystemAppearance();
        }

        @JavascriptInterface
        public void applyAppearance(String json) {
            if (json != null) applyNativeAppearanceJson(json);
        }

        @JavascriptInterface
        public boolean commitAppearance(String snapshotJson) {
            return snapshotJson != null && commitAppearanceSnapshot(snapshotJson);
        }

        @JavascriptInterface
        public void pickImage() {
            pickImageWithToken(null);
        }

        @JavascriptInterface
        public void pickImageWithToken(String token) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    cancelImageTask();
                    imageCallbackToken = token;
                    showPhotoSourceSheet();
                }
            });
        }

        @JavascriptInterface
        public void toast(String message) {
            if (message == null) return;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void exit() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    finish();
                }
            });
        }
    }

    // ------------------------------------------------------------------
    // 相机 / 相册
    // ------------------------------------------------------------------

    private void showPhotoSourceSheet() {
        if (isFinishing() || isDestroyed()
                || (photoSourceDialog != null && photoSourceDialog.isShowing())) return;
        LinearLayout sheet = new LinearLayout(this);
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setPadding(dp(18), dp(10), dp(18), dp(18));

        photoSourceSheet = sheet;
        applyPhotoSourceAppearance();
        sheet.setElevation(dp(10));

        View handle = new View(this);
        GradientDrawable handleShape = new GradientDrawable();
        handleShape.setColor((appearance.mutedInk & 0x00FFFFFF) | 0x55000000);
        handleShape.setCornerRadius(dp(2));
        handle.setBackground(handleShape);
        photoSourceHandle = handle;
        LinearLayout.LayoutParams handleLp = new LinearLayout.LayoutParams(dp(32), dp(4));
        handleLp.gravity = Gravity.CENTER_HORIZONTAL;
        handleLp.bottomMargin = dp(10);
        sheet.addView(handle, handleLp);

        TextView title = new TextView(this);
        title.setText("选择图片来源");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        title.setTextColor(appearance.ink);
        photoSourceTitle = title;
        title.setPadding(dp(4), dp(4), dp(4), dp(10));
        sheet.addView(title, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView takePhoto = photoSourceAction("拍照");
        TextView choosePhoto = photoSourceAction("从相册选择");
        photoSourceTakePhoto = takePhoto;
        photoSourceChoosePhoto = choosePhoto;
        applyPhotoSourceAppearance();
        sheet.addView(takePhoto);
        sheet.addView(choosePhoto);
        PhotoSourceDialog dialog = new PhotoSourceDialog(sheet);
        takePhoto.setOnClickListener(v -> dialog.dismissThen(this::launchCamera));
        choosePhoto.setOnClickListener(v -> dialog.dismissThen(this::openGallery));

        Window window = dialog.getWindow();
        if (window == null) return;
        window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        window.setDimAmount(0.22f);
        window.setNavigationBarColor(Color.TRANSPARENT);
        window.setGravity(Gravity.BOTTOM);
        photoSourceDialog = dialog;
        dialog.show();
        window.getDecorView().setSystemUiVisibility(systemUiFlags());
        window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);

        sheet.setAlpha(0f);
        sheet.setTranslationY(dp(12));
        sheet.animate().alpha(1f).translationY(0)
                .setDuration(UiMotion.duration(this, UiMotion.DIALOG_MS))
                .setInterpolator(UiMotion.enter()).start();
    }

    private final class PhotoSourceDialog extends Dialog {
        private final View sheet;
        private boolean dismissing;

        PhotoSourceDialog(View sheet) {
            super(MainActivity.this);
            this.sheet = sheet;
            setContentView(sheet);
            setCanceledOnTouchOutside(true);
        }

        @Override
        public void dismiss() {
            dismissThen(null);
        }

        void dismissThen(Runnable nextAction) {
            if (dismissing || !isShowing()) return;
            dismissing = true;
            sheet.animate().cancel();
            long duration = UiMotion.duration(MainActivity.this, UiMotion.FAST_MS);
            Runnable finish = () -> {
                dismissImmediately();
                if (nextAction != null && !isFinishing() && !isDestroyed()) {
                    nextAction.run();
                }
            };
            if (duration == 0L) {
                finish.run();
                return;
            }
            sheet.animate().alpha(0f).translationY(dp(12))
                    .setDuration(duration)
                    .setInterpolator(UiMotion.standard())
                    .withEndAction(finish).start();
        }

        void dismissImmediately() {
            dismissing = true;
            sheet.animate().cancel();
            super.dismiss();
            if (photoSourceDialog == this) {
                photoSourceDialog = null;
                photoSourceSheet = null;
                photoSourceHandle = null;
                photoSourceTitle = null;
                photoSourceTakePhoto = null;
                photoSourceChoosePhoto = null;
            }
        }
    }

    private TextView photoSourceAction(String label) {
        TextView action = new TextView(this);
        action.setText(label);
        action.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        action.setTextColor(appearance.mutedInk);
        action.setGravity(Gravity.CENTER_VERTICAL);
        action.setPadding(dp(12), 0, dp(12), 0);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(48));
        lp.bottomMargin = dp(4);
        action.setLayoutParams(lp);

        GradientDrawable fill = new GradientDrawable();
        fill.setColor(appearance.controlFill);
        fill.setCornerRadius(dp(14));
        GradientDrawable mask = new GradientDrawable();
        mask.setColor(Color.WHITE);
        mask.setCornerRadius(dp(14));
        action.setBackground(new RippleDrawable(
                ColorStateList.valueOf(appearance.ripple), fill, mask));
        return action;
    }

    private void launchCamera() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                && checkSelfPermission(android.Manifest.permission.CAMERA)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.CAMERA}, REQ_CAMERA_PERM);
            return;
        }
        cancelImageTask();
        startActivityForResult(new Intent(this, CameraActivity.class), REQ_CAMERA);
    }

    private void openGallery() {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("image/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            cancelImageTask();
            startActivityForResult(Intent.createChooser(intent, "选择图片"), REQ_GALLERY);
        } catch (Exception e) {
            Toast.makeText(this, "没有可用的相册应用", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_CAMERA_PERM) {
            if (results.length > 0 && results[0] == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                cancelImageTask();
                startActivityForResult(new Intent(this, CameraActivity.class), REQ_CAMERA);
            } else {
                Toast.makeText(this, "没有相机权限，可从相册选择图片", Toast.LENGTH_SHORT).show();
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null || isFinishing() || isDestroyed()) return;

        Uri uri = data.getData();
        if (uri == null) return;

        cancelImageTask();
        final int request = imageRequestSequence;
        final String callbackToken = imageCallbackToken;
        imageTask = imageIo.submit(() -> {
            String script = null;
            try {
                String dataUrl = uriToDataUrl(uri);
                if (Thread.currentThread().isInterrupted()) return;
                if (dataUrl != null) {
                    // Escaping a large data URL is also CPU work; only WebView delivery belongs on UI.
                    script = "window.__itOnImage && window.__itOnImage(" + jsString(dataUrl)
                            + "," + jsString(callbackToken) + ")";
                }
            } catch (OutOfMemoryError error) {
                Log.w(TAG, "Unable to prepare image for WebView", error);
            }
            final String imageScript = script;
            runOnUiThread(() -> {
                if (request != imageRequestSequence || isFinishing() || isDestroyed()
                        || webView == null) return;
                imageTask = null;
                if (imageScript == null) {
                    Toast.makeText(this, "读取图片失败", Toast.LENGTH_SHORT).show();
                    return;
                }
                webView.evaluateJavascript(imageScript, null);
            });
        });
    }

    private void cancelImageTask() {
        imageRequestSequence++;
        if (imageTask != null) {
            imageTask.cancel(true);
            imageTask = null;
        }
    }

    /** 压缩到最长边 1600px 的 JPEG，再转 dataURL（与桌面端 shrinkImage 同参） */
    private String uriToDataUrl(Uri uri) {
        Bitmap bitmap = null;
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            try (InputStream probe = getContentResolver().openInputStream(uri)) {
                if (probe == null) return null;
                BitmapFactory.decodeStream(probe, null, bounds);
            }
            if (Thread.currentThread().isInterrupted()) return null;

            int sample = 1;
            int longest = Math.max(bounds.outWidth, bounds.outHeight);
            while (longest / sample > 1600) sample *= 2;

            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = sample;
            try (InputStream in = getContentResolver().openInputStream(uri)) {
                if (in == null) return null;
                bitmap = BitmapFactory.decodeStream(in, null, options);
            }
            if (bitmap == null) return null;
            if (Thread.currentThread().isInterrupted()) return null;

            bitmap = rotateByExif(uri, bitmap);

            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.JPEG, 85, out);
            bitmap.recycle();

            return "data:image/jpeg;base64," +
                    Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        } catch (OutOfMemoryError e) {
            return null;
        } finally {
            if (bitmap != null && !bitmap.isRecycled()) bitmap.recycle();
        }
    }

    private Bitmap rotateByExif(Uri uri, Bitmap bitmap) {
        try {
            int orientation;
            try (InputStream in = getContentResolver().openInputStream(uri)) {
                if (in == null) return bitmap;
                ExifInterface exif = new ExifInterface(in);
                orientation = exif.getAttributeInt(
                        ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            }
            int degrees = 0;
            if (orientation == ExifInterface.ORIENTATION_ROTATE_90) degrees = 90;
            else if (orientation == ExifInterface.ORIENTATION_ROTATE_180) degrees = 180;
            else if (orientation == ExifInterface.ORIENTATION_ROTATE_270) degrees = 270;
            if (degrees == 0) return bitmap;
            android.graphics.Matrix matrix = new android.graphics.Matrix();
            matrix.postRotate(degrees);
            Bitmap rotated = Bitmap.createBitmap(bitmap, 0, 0,
                    bitmap.getWidth(), bitmap.getHeight(), matrix, true);
            if (rotated != bitmap) bitmap.recycle();
            return rotated;
        } catch (Exception e) {
            return bitmap;
        }
    }

    private static String jsString(String value) {
        if (value == null) return "null";
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append("\"").toString();
    }

    // ------------------------------------------------------------------
    // 返回键 / 工具
    // ------------------------------------------------------------------

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null) {
            if (event.getRepeatCount() > 0) return true;
            webView.evaluateJavascript(
                    "(function(){" +
                    "if(typeof window.__itHandleBack==='function'){" +
                    "return window.__itHandleBack()?'handled':'pass';}" +
                    "var d=document.querySelector('details[open]');" +
                    "if(d){d.removeAttribute('open');return 'handled';}" +
                    "var m=document.getElementById('more-menu');" +
                    "if(m&&!m.hidden){m.hidden=true;return 'handled';}" +
                    "return 'pass';})()",
                    value -> {
                        if (!"\"handled\"".equals(value)) finish();
                    });
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
