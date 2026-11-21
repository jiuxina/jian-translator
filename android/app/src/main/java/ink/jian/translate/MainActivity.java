package ink.jian.translate;

import android.app.Activity;
import android.app.Dialog;
import android.content.res.Configuration;
import android.content.res.ColorStateList;
import android.content.Intent;
import android.content.SharedPreferences;
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
import android.webkit.ValueCallback;
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
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
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
    private static final int REQ_DOCUMENT = 1006;
    private static final int REQ_EXPORT = 1007;

    private static final String ASSET_URL = "file:///android_asset/index.html";
    private static final String APPEARANCE_PREFS = "native_appearance";
    private static final String APPEARANCE_SNAPSHOT_KEY = "snapshot";
    private static final String TRANSFER_PREFS = "pending_transfers";
    private static final int MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
    private static final Object EXPORT_IO_LOCK = new Object();

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
    private String imagePurpose = "translation";
    private String pendingImageUri;
    private ValueCallback<Uri[]> documentCallback;
    private String documentRevision = "0";
    private String pendingDocumentUri;
    private String pendingExportPath;
    private String pendingExportUri;
    private String exportStatus;
    private String exportMessage;
    private boolean bridgeIsReady;
    private boolean restoredImageRequest;
    private boolean imageDeliveryRunning;
    private boolean documentDeliveryRunning;
    private boolean documentDeliveredToPage;
    private boolean exportRunning;
    private int pageGeneration;
    private long exportNotificationSequence;

    // ------------------------------------------------------------------
    // 生命周期
    // ------------------------------------------------------------------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        appearance = loadAppearanceSnapshot();
        restorePendingTransfers();
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
            if (webView.restoreState(savedInstanceState) == null) webView.loadUrl(ASSET_URL);
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
        bridgeIsReady = false;
        if (documentCallback != null) {
            documentCallback.onReceiveValue(null);
            documentCallback = null;
        }
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
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                pageGeneration++;
                pageLoaded = false;
                bridgeIsReady = false;
                documentDeliveredToPage = false;
                restoredImageRequest = imageCallbackToken != null;
                if (documentCallback != null) {
                    documentCallback.onReceiveValue(null);
                    documentCallback = null;
                }
            }
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
                deliverPendingTransfers();
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
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                    FileChooserParams parameters) {
                if (documentCallback != null) {
                    callback.onReceiveValue(null);
                    return true;
                }
                documentCallback = callback;
                pendingDocumentUri = null;
                persistPendingTransfers();
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("text/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES,
                        new String[]{"text/plain", "text/markdown", "text/x-markdown"});
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                try {
                    startActivityForResult(intent, REQ_DOCUMENT);
                } catch (Exception error) {
                    documentCallback = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "没有可用的文件选择器", Toast.LENGTH_SHORT).show();
                }
                return true;
            }

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
        public void hideKeyboard() {
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || webView == null) return;
                WindowCompat.getInsetsController(getWindow(), webView)
                        .hide(WindowInsetsCompat.Type.ime());
            });
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
            pickImageWithTokenAndPurpose(token, "translation");
        }

        @JavascriptInterface
        public void pickImageWithTokenAndPurpose(String token, String purpose) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (isFinishing() || isDestroyed()) return;
                    cancelImageTask();
                    imageCallbackToken = token;
                    imagePurpose = "background".equals(purpose)
                            || "popup-background".equals(purpose) ? purpose : "translation";
                    pendingImageUri = null;
                    restoredImageRequest = false;
                    persistPendingTransfers();
                    showPhotoSourceSheet();
                }
            });
        }

        @JavascriptInterface
        public void bridgeReady() {
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                bridgeIsReady = true;
                deliverPendingTransfers();
            });
        }

        @JavascriptInterface
        public void acknowledgeImage(String token) {
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (java.util.Objects.equals(token, imageCallbackToken)) clearPendingImage();
            });
        }

        @JavascriptInterface
        public void prepareDocumentImport(String revision) {
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                documentRevision = revision == null ? "0" : revision.substring(0, Math.min(64, revision.length()));
                persistPendingTransfers();
            });
        }

        @JavascriptInterface
        public void acknowledgeDocumentImport(String revision) {
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (java.util.Objects.equals(revision, documentRevision)) {
                    pendingDocumentUri = null;
                    persistPendingTransfers();
                }
            });
        }

        @JavascriptInterface
        public void saveDocument(String filename, String text) {
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (pendingExportPath != null || exportRunning) {
                    notifyDocumentSaved("error", "请先完成当前保存");
                    return;
                }
                if (text == null || text.trim().isEmpty()) {
                    notifyDocumentSaved("error", "还没有译文");
                    return;
                }
                if (text.length() > MAX_DOCUMENT_BYTES) {
                    notifyDocumentSaved("error", "译文过大，请分段保存");
                    return;
                }
                final String safeName = filename == null ? "译文.txt"
                        : filename.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");
                exportRunning = true;
                imageIo.execute(() -> {
                    File file = new File(getCacheDir(), "document-export-" + java.util.UUID.randomUUID() + ".txt");
                    boolean prepared = false;
                    try (FileOutputStream stream = new FileOutputStream(file)) {
                        stream.write(text.getBytes(StandardCharsets.UTF_8));
                        prepared = true;
                    } catch (Exception error) {
                        Log.w(TAG, "Unable to prepare document export");
                    }
                    final boolean ready = prepared;
                    runOnUiThread(() -> {
                        exportRunning = false;
                        if (isFinishing() || isDestroyed()) return;
                        if (!ready) {
                            notifyDocumentSaved("error", "无法准备译文文件");
                            return;
                        }
                        pendingExportPath = file.getAbsolutePath();
                        pendingExportUri = null;
                        persistPendingTransfers();
                        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                        intent.addCategory(Intent.CATEGORY_OPENABLE);
                        intent.setType("text/plain");
                        intent.putExtra(Intent.EXTRA_TITLE, safeName.isEmpty() ? "译文.txt" : safeName);
                        intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                        try {
                            startActivityForResult(intent, REQ_EXPORT);
                        } catch (Exception error) {
                            finishExport("error", "没有可用的保存位置选择器");
                        }
                    });
                });
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

    private void restorePendingTransfers() {
        SharedPreferences prefs = getSharedPreferences(TRANSFER_PREFS, MODE_PRIVATE);
        imageCallbackToken = prefs.getString("image_token", null);
        imagePurpose = prefs.getString("image_purpose", "translation");
        pendingImageUri = prefs.getString("image_uri", null);
        documentRevision = prefs.getString("document_revision", "0");
        pendingDocumentUri = prefs.getString("document_uri", null);
        pendingExportPath = prefs.getString("export_path", null);
        pendingExportUri = prefs.getString("export_uri", null);
        exportStatus = prefs.getString("export_status", null);
        exportMessage = prefs.getString("export_message", null);
        restoredImageRequest = imageCallbackToken != null;
    }

    private void persistPendingTransfers() {
        // Save identifiers/URIs only. Large image/document payloads never enter a Bundle.
        getSharedPreferences(TRANSFER_PREFS, MODE_PRIVATE).edit()
                .putString("image_token", imageCallbackToken)
                .putString("image_purpose", imagePurpose)
                .putString("image_uri", pendingImageUri)
                .putString("document_revision", documentRevision)
                .putString("document_uri", pendingDocumentUri)
                .putString("export_path", pendingExportPath)
                .putString("export_uri", pendingExportUri)
                .putString("export_status", exportStatus)
                .putString("export_message", exportMessage).commit();
    }

    private void clearPendingImage() {
        pendingImageUri = null;
        imageCallbackToken = null;
        restoredImageRequest = false;
        persistPendingTransfers();
    }

    private void retainUriAccess(Uri uri, Intent data) {
        int flags = data.getFlags()
                & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        try { getContentResolver().takePersistableUriPermission(uri, flags); }
        catch (Exception ignored) { /* Some providers offer only the transient grant. */ }
    }

    private void deliverPendingTransfers() {
        if (!bridgeIsReady || !pageLoaded || webView == null || isFinishing() || isDestroyed()) return;
        if (pendingImageUri != null && !imageDeliveryRunning) deliverPendingImage();
        if (pendingDocumentUri != null && documentCallback == null
                && !documentDeliveredToPage && !documentDeliveryRunning) {
            deliverPendingDocument();
        }
        if (pendingExportUri != null && pendingExportPath != null && !exportRunning) writePendingExport();
        if (exportStatus != null) {
            String status = exportStatus;
            String message = exportMessage;
            final long notification = exportNotificationSequence;
            webView.evaluateJavascript("(function(){if(typeof window.__itOnDocumentSaved!=='function')return false;"
                    + "window.__itOnDocumentSaved(" + jsString(status) + "," + jsString(message)
                    + ");return true;})()", value -> {
                        if (!isFinishing() && !isDestroyed() && "true".equals(value)
                                && notification == exportNotificationSequence) {
                            exportStatus = null;
                            exportMessage = null;
                            persistPendingTransfers();
                        }
                    });
        }
    }

    private void deliverPendingImage() {
        cancelImageTask();
        imageDeliveryRunning = true;
        final int request = imageRequestSequence;
        final int requestPage = pageGeneration;
        final String uriText = pendingImageUri;
        final String token = imageCallbackToken;
        final String purpose = imagePurpose;
        final boolean restored = restoredImageRequest;
        imageTask = imageIo.submit(() -> {
            String image = uriToDataUrl(Uri.parse(uriText));
            if (Thread.currentThread().isInterrupted()) return;
            String script = image == null ? null : (restored
                    ? "window.__itRestoreImage && window.__itRestoreImage(" + jsString(image) + ","
                            + jsString(token) + "," + jsString(purpose) + ")"
                    : "window.__itOnImage && window.__itOnImage(" + jsString(image) + "," + jsString(token) + ")");
            runOnUiThread(() -> {
                if (request != imageRequestSequence || isFinishing() || isDestroyed()) return;
                imageTask = null;
                imageDeliveryRunning = false;
                if (requestPage != pageGeneration) {
                    deliverPendingTransfers();
                    return;
                }
                if (!bridgeIsReady || !pageLoaded || webView == null) return;
                if (script == null) {
                    clearPendingImage();
                    Toast.makeText(this, "读取图片失败，请重新选择", Toast.LENGTH_SHORT).show();
                    return;
                }
                // The web hook explicitly acknowledges matching or intentionally stale tokens.
                webView.evaluateJavascript(script, null);
            });
        });
    }

    private void deliverPendingDocument() {
        documentDeliveryRunning = true;
        final String uriText = pendingDocumentUri;
        final String revision = documentRevision;
        imageIo.execute(() -> {
            String text = null;
            String name = "导入文档";
            try {
                Uri uri = Uri.parse(uriText);
                try (android.database.Cursor cursor = getContentResolver().query(uri,
                        new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
                }
                try (InputStream stream = getContentResolver().openInputStream(uri)) {
                    if (stream == null) throw new java.io.IOException("Missing document stream");
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    byte[] block = new byte[8192];
                    int count;
                    while ((count = stream.read(block)) != -1) {
                        if (Thread.currentThread().isInterrupted()) return;
                        if (bytes.size() + count > MAX_DOCUMENT_BYTES) throw new java.io.IOException("Document too large");
                        bytes.write(block, 0, count);
                    }
                    text = bytes.toString(StandardCharsets.UTF_8.name());
                    if (text.startsWith("\uFEFF")) text = text.substring(1);
                }
            } catch (Exception error) {
                Log.w(TAG, "Unable to restore document import");
            }
            final String result = text;
            final String filename = name;
            runOnUiThread(() -> {
                documentDeliveryRunning = false;
                if (isFinishing() || isDestroyed()) return;
                if (!java.util.Objects.equals(uriText, pendingDocumentUri)
                        || !java.util.Objects.equals(revision, documentRevision)) {
                    deliverPendingTransfers();
                    return;
                }
                if (result == null) {
                    pendingDocumentUri = null;
                    persistPendingTransfers();
                    Toast.makeText(this, "读取文件失败，文件需为不超过 8 MB 的 UTF-8 文本", Toast.LENGTH_LONG).show();
                    return;
                }
                if (bridgeIsReady && pageLoaded && webView != null) {
                    webView.evaluateJavascript("window.__itOnRestoredDocument && window.__itOnRestoredDocument("
                            + jsString(result) + "," + jsString(filename) + "," + jsString(revision) + ")", null);
                }
            });
        });
    }

    private void writePendingExport() {
        if (exportRunning || pendingExportPath == null || pendingExportUri == null) return;
        exportRunning = true;
        final String path = pendingExportPath;
        final String uriText = pendingExportUri;
        imageIo.execute(() -> {
            boolean success = false;
            // An Activity can be reconstructed while its predecessor's I/O is settling.
            synchronized (EXPORT_IO_LOCK) {
                try (InputStream input = new java.io.FileInputStream(path);
                        OutputStream output = getContentResolver().openOutputStream(Uri.parse(uriText), "wt")) {
                    if (output == null) throw new java.io.IOException("Missing destination stream");
                    byte[] block = new byte[8192];
                    int count;
                    while ((count = input.read(block)) != -1) output.write(block, 0, count);
                    output.flush();
                    success = true;
                } catch (Exception error) {
                    Log.w(TAG, "Unable to save document");
                }
            }
            final boolean saved = success;
            runOnUiThread(() -> {
                exportRunning = false;
                if (isFinishing() || isDestroyed()) return;
                finishExport(saved ? "saved" : "error", saved ? "译文已保存" : "保存失败，请重新选择保存位置");
            });
        });
    }

    private void finishExport(String status, String message) {
        final String completedPath = pendingExportPath;
        pendingExportPath = null;
        pendingExportUri = null;
        notifyDocumentSaved(status, message);
        // Each request owns its file, so an old cleanup cannot truncate a newer export.
        if (completedPath != null) imageIo.execute(() -> {
            synchronized (EXPORT_IO_LOCK) {
                try (FileOutputStream stream = new FileOutputStream(completedPath)) {
                    stream.getChannel().truncate(0);
                } catch (Exception ignored) { }
            }
        });
    }

    private void notifyDocumentSaved(String status, String message) {
        exportNotificationSequence++;
        exportStatus = status;
        exportMessage = message;
        persistPendingTransfers();
        deliverPendingTransfers();
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
                } else if (nextAction == null) {
                    clearPendingImage();
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
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.setType("image/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
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
        if (isFinishing() || isDestroyed()) return;
        Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
        if (requestCode == REQ_DOCUMENT) {
            ValueCallback<Uri[]> callback = documentCallback;
            documentCallback = null;
            pendingDocumentUri = uri == null ? null : uri.toString();
            if (uri != null) retainUriAccess(uri, data);
            persistPendingTransfers();
            if (callback != null) {
                documentDeliveredToPage = uri != null;
                callback.onReceiveValue(uri == null ? null : new Uri[]{uri});
            } else {
                deliverPendingTransfers();
            }
            return;
        }
        if (requestCode == REQ_EXPORT) {
            if (exportRunning || pendingExportUri != null) return;
            if (uri == null) {
                finishExport("cancelled", "已取消保存");
            } else {
                retainUriAccess(uri, data);
                pendingExportUri = uri.toString();
                persistPendingTransfers();
                if (pendingExportPath == null) finishExport("error", "译文缓存已失效，请重新下载");
                else writePendingExport();
            }
            return;
        }
        if (requestCode != REQ_CAMERA && requestCode != REQ_GALLERY) return;
        if (uri == null) {
            clearPendingImage();
            return;
        }
        if (requestCode == REQ_GALLERY) retainUriAccess(uri, data);
        pendingImageUri = uri.toString();
        persistPendingTransfers();
        deliverPendingTransfers();
    }

    private void cancelImageTask() {
        imageRequestSequence++;
        imageDeliveryRunning = false;
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
            if (bitmap.hasAlpha()) {
                Bitmap opaque = Bitmap.createBitmap(bitmap.getWidth(), bitmap.getHeight(), Bitmap.Config.ARGB_8888);
                android.graphics.Canvas canvas = new android.graphics.Canvas(opaque);
                canvas.drawColor(Color.WHITE);
                canvas.drawBitmap(bitmap, 0, 0, null);
                bitmap.recycle();
                bitmap = opaque;
            }

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
                    if (c < 0x20 || c == '\u2028' || c == '\u2029') sb.append(String.format("\\u%04x", (int) c));
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
