package ink.jian.translate;

import android.app.Activity;
import android.app.Dialog;
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
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
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

import androidx.exifinterface.media.ExifInterface;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * 「笺」Android 壳（v2 自绘前端）。
 *
 * 与 v1 的区别：不再加载官网页面、不再注入 CSS/JS。界面由 assets/ 下的
 * web 前端（与本仓库 web/ 目录同源，构建时同步）自己绘制，翻译请求直连官方
 * 公开接口 https://index-translate.bilibili.com/v1/chat/completions。
 *
 * 原生侧只负责 WebView 容器、相机/相册、系统栏内边距和返回键。
 */
public class MainActivity extends Activity {

    private static final int REQ_CAMERA = 1003;
    private static final int REQ_GALLERY = 1005;
    private static final int REQ_CAMERA_PERM = 1004;

    private static final String ASSET_URL = "file:///android_asset/index.html";

    private static final int COLOR_BG = 0xFFF3EFF6;
    private static final int COLOR_INK = 0xFF2E2A38;
    private static final int COLOR_INK_SUB = 0xFF6E687E;
    private static final int COLOR_ACCENT = 0xFFC96F90;

    private FrameLayout root;
    private WebView webView;
    private LinearLayout overlay;
    private ProgressBar spinner;
    private TextView overlayText;
    private Button retryButton;
    private PhotoSourceDialog photoSourceDialog;

    private boolean pageLoaded = false;

    // ------------------------------------------------------------------
    // 生命周期
    // ------------------------------------------------------------------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            Window window = getWindow();
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                            | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
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
    protected void onDestroy() {
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
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                int top, bottom, left, right;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    android.graphics.Insets bars = insets.getInsets(
                            WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                    top = bars.top; bottom = bars.bottom; left = bars.left; right = bars.right;
                } else {
                    top = insets.getSystemWindowInsetTop();
                    bottom = insets.getSystemWindowInsetBottom();
                    left = insets.getSystemWindowInsetLeft();
                    right = insets.getSystemWindowInsetRight();
                }
                if (webView != null) {
                    webView.setPadding(left, top, right, bottom);
                }
                return insets;
            }
        });
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
        spinner.setIndeterminateTintList(ColorStateList.valueOf(COLOR_ACCENT));
        LinearLayout.LayoutParams spinnerLp = new LinearLayout.LayoutParams(
                dp(28), dp(28));
        overlay.addView(spinner, spinnerLp);

        overlayText = new TextView(this);
        overlayText.setText("正在准备…");
        overlayText.setTextColor(COLOR_INK_SUB);
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
        bg.setColor(COLOR_ACCENT);
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
                new int[]{0xFFFCF8FB, COLOR_BG, 0xFFEBE5F4});
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
        public void pickImage() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
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

        GradientDrawable surface = new GradientDrawable();
        surface.setColor(getColor(R.color.glass_strong));
        surface.setCornerRadius(dp(24));
        surface.setStroke(dp(1), getColor(R.color.glass_edge));
        sheet.setBackground(surface);
        sheet.setElevation(dp(10));

        View handle = new View(this);
        GradientDrawable handleShape = new GradientDrawable();
        handleShape.setColor(0x55776E82);
        handleShape.setCornerRadius(dp(2));
        handle.setBackground(handleShape);
        LinearLayout.LayoutParams handleLp = new LinearLayout.LayoutParams(dp(32), dp(4));
        handleLp.gravity = Gravity.CENTER_HORIZONTAL;
        handleLp.bottomMargin = dp(10);
        sheet.addView(handle, handleLp);

        TextView title = new TextView(this);
        title.setText("选择图片来源");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        title.setTextColor(COLOR_INK);
        title.setPadding(dp(4), dp(4), dp(4), dp(10));
        sheet.addView(title, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView takePhoto = photoSourceAction("拍照");
        TextView choosePhoto = photoSourceAction("从相册选择");
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
            if (photoSourceDialog == this) photoSourceDialog = null;
        }
    }

    private TextView photoSourceAction(String label) {
        TextView action = new TextView(this);
        action.setText(label);
        action.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        action.setTextColor(COLOR_INK_SUB);
        action.setGravity(Gravity.CENTER_VERTICAL);
        action.setPadding(dp(12), 0, dp(12), 0);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(48));
        lp.bottomMargin = dp(4);
        action.setLayoutParams(lp);

        GradientDrawable fill = new GradientDrawable();
        fill.setColor(0x24FFFFFF);
        fill.setCornerRadius(dp(14));
        GradientDrawable mask = new GradientDrawable();
        mask.setColor(Color.WHITE);
        mask.setCornerRadius(dp(14));
        action.setBackground(new RippleDrawable(
                ColorStateList.valueOf(0x33C96F90), fill, mask));
        return action;
    }

    private void launchCamera() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                && checkSelfPermission(android.Manifest.permission.CAMERA)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.CAMERA}, REQ_CAMERA_PERM);
            return;
        }
        startActivityForResult(new Intent(this, CameraActivity.class), REQ_CAMERA);
    }

    private void openGallery() {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("image/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        try {
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
                startActivityForResult(new Intent(this, CameraActivity.class), REQ_CAMERA);
            } else {
                Toast.makeText(this, "没有相机权限，可从相册选择图片", Toast.LENGTH_SHORT).show();
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null) return;

        Uri uri = data.getData();
        if (uri == null) return;

        String dataUrl = uriToDataUrl(uri);
        if (dataUrl == null) {
            Toast.makeText(this, "读取图片失败", Toast.LENGTH_SHORT).show();
            return;
        }
        deliverImage(dataUrl);
    }

    private void deliverImage(String dataUrl) {
        if (webView == null) return;
        String js = "window.__itOnImage && window.__itOnImage(" + jsString(dataUrl) + ")";
        webView.evaluateJavascript(js, null);
    }

    /** 压缩到最长边 1600px 的 JPEG，再转 dataURL（与桌面端 shrinkImage 同参） */
    private String uriToDataUrl(Uri uri) {
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            InputStream probe = getContentResolver().openInputStream(uri);
            if (probe == null) return null;
            BitmapFactory.decodeStream(probe, null, bounds);
            probe.close();

            int sample = 1;
            int longest = Math.max(bounds.outWidth, bounds.outHeight);
            while (longest / sample > 1600) sample *= 2;

            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = sample;
            InputStream in = getContentResolver().openInputStream(uri);
            if (in == null) return null;
            Bitmap bitmap = BitmapFactory.decodeStream(in, null, options);
            in.close();
            if (bitmap == null) return null;

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
        }
    }

    private Bitmap rotateByExif(Uri uri, Bitmap bitmap) {
        try {
            InputStream in = getContentResolver().openInputStream(uri);
            if (in == null) return bitmap;
            ExifInterface exif = new ExifInterface(in);
            in.close();
            int orientation = exif.getAttributeInt(
                    ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
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
