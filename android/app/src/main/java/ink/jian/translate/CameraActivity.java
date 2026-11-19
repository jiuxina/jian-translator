package ink.jian.translate;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Paint;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.MeteringPoint;
import androidx.camera.core.MeteringPointFactory;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.exifinterface.media.ExifInterface;

import com.google.common.util.concurrent.ListenableFuture;

import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * 应用内相机：全屏预览 + 快门 + 前后摄 / 闪光灯 / 点按对焦，
 * 拍完可以先确认再回填到网页「图片翻译」，全程不跳出应用。
 */
public class CameraActivity extends ComponentActivity {

    public static final String EXTRA_ERROR = "camera_error";

    private static final int REQ_CAMERA_PERM = 2001;

    private FrameLayout root;
    private PreviewView previewView;
    private LinearLayout topBar;
    private LinearLayout bottomBar;
    private FrameLayout confirmLayer;
    private ImageView confirmImage;
    private ImageView flashIcon;
    private View focusRing;

    private ProcessCameraProvider cameraProvider;
    private Camera camera;
    private ImageCapture imageCapture;

    private int lensFacing = CameraSelector.LENS_FACING_BACK;
    private boolean flashOn = false;
    private boolean capturing = false;
    private File shotFile;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private Future<?> confirmTask;
    private int captureSequence;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        applyFullscreen();
        buildUi();
        setContentView(root);
        applyInsets();
        cleanupOldShots();

        if (!hasCameraPermission()) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA_PERM);
        } else {
            startCamera();
        }
    }

    // ------------------------------------------------------------------
    // UI
    // ------------------------------------------------------------------

    private void buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        previewView = new PreviewView(this);
        previewView.setImplementationMode(PreviewView.ImplementationMode.PERFORMANCE);
        previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        previewView.setBackgroundColor(Color.BLACK);
        root.addView(previewView, match());

        root.addView(new GridOverlay(this), match());

        // 顶部/底部渐变压暗，保证白色控件和文字在明亮画面上也清晰
        View topScrim = new View(this);
        topScrim.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{0x99000000, 0x00000000}));
        FrameLayout.LayoutParams topScrimLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(160));
        topScrimLp.gravity = Gravity.TOP;
        root.addView(topScrim, topScrimLp);

        View bottomScrim = new View(this);
        bottomScrim.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{0x00000000, 0xB3000000}));
        FrameLayout.LayoutParams bottomScrimLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(220));
        bottomScrimLp.gravity = Gravity.BOTTOM;
        root.addView(bottomScrim, bottomScrimLp);

        focusRing = new View(this);
        GradientDrawable ring = new GradientDrawable();
        ring.setShape(GradientDrawable.OVAL);
        ring.setColor(Color.TRANSPARENT);
        ring.setStroke(dp(1.5f), 0xCCFFFFFF);
        focusRing.setBackground(ring);
        focusRing.setAlpha(0f);
        FrameLayout.LayoutParams ringLp = new FrameLayout.LayoutParams(dp(62), dp(62));
        root.addView(focusRing, ringLp);

        buildTopBar();
        buildBottomBar();
        buildConfirmLayer();
    }

    private void buildTopBar() {
        topBar = new LinearLayout(this);
        topBar.setOrientation(LinearLayout.HORIZONTAL);
        topBar.setGravity(Gravity.CENTER_VERTICAL);
        topBar.setPadding(dp(16), dp(10), dp(16), dp(10));

        View close = circleButton(R.drawable.ic_cam_close, "关闭相机");
        close.setOnClickListener(v -> finishWithCancel());
        topBar.addView(close, new LinearLayout.LayoutParams(dp(40), dp(40)));

        View spacer = new View(this);
        topBar.addView(spacer, new LinearLayout.LayoutParams(0, 1, 1f));

        View flash = circleButton(R.drawable.ic_cam_flash, "闪光灯");
        flashIcon = (ImageView) ((FrameLayout) flash).getChildAt(0);
        flash.setOnClickListener(v -> toggleFlash());
        LinearLayout.LayoutParams flashLp = new LinearLayout.LayoutParams(dp(40), dp(40));
        flashLp.rightMargin = dp(12);
        topBar.addView(flash, flashLp);

        View flip = circleButton(R.drawable.ic_cam_flip, "切换摄像头");
        flip.setOnClickListener(v -> switchCamera());
        topBar.addView(flip, new LinearLayout.LayoutParams(dp(40), dp(40)));

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.TOP;
        root.addView(topBar, lp);
    }

    private void buildBottomBar() {
        bottomBar = new LinearLayout(this);
        bottomBar.setOrientation(LinearLayout.VERTICAL);
        bottomBar.setGravity(Gravity.CENTER_HORIZONTAL);
        bottomBar.setPadding(0, dp(10), 0, dp(26));

        TextView hint = new TextView(this);
        hint.setText("点按画面对焦");
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        hint.setTextColor(0x99FFFFFF);
        hint.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hintLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hintLp.bottomMargin = dp(14);
        bottomBar.addView(hint, hintLp);

        FrameLayout shutter = new FrameLayout(this);
        shutter.setContentDescription("拍照");
        shutter.setFocusable(true);
        shutter.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        GradientDrawable shutterMask = new GradientDrawable();
        shutterMask.setShape(GradientDrawable.OVAL);
        shutterMask.setColor(Color.WHITE);
        GradientDrawable shutterRipple = new GradientDrawable();
        shutterRipple.setShape(GradientDrawable.OVAL);
        shutterRipple.setColor(0x22000000);
        shutter.setBackground(new RippleDrawable(
                ColorStateList.valueOf(0x4CFFFFFF), shutterRipple, shutterMask));
        View ring = new View(this);
        GradientDrawable ringBg = new GradientDrawable();
        ringBg.setShape(GradientDrawable.OVAL);
        ringBg.setColor(Color.TRANSPARENT);
        ringBg.setStroke(dp(3.5f), Color.WHITE);
        ring.setBackground(ringBg);
        shutter.addView(ring, new FrameLayout.LayoutParams(dp(74), dp(74), Gravity.CENTER));

        View core = new View(this);
        GradientDrawable coreBg = new GradientDrawable();
        coreBg.setShape(GradientDrawable.OVAL);
        coreBg.setColor(Color.WHITE);
        core.setBackground(coreBg);
        FrameLayout.LayoutParams coreLp = new FrameLayout.LayoutParams(dp(58), dp(58), Gravity.CENTER);
        shutter.addView(core, coreLp);

        shutter.setOnClickListener(v -> {
            if (shutter.isEnabled()) {
                shutter.setEnabled(false);
                shutter.animate().scaleX(0.92f).scaleY(0.92f)
                        .setDuration(UiMotion.duration(this, UiMotion.FAST_MS))
                        .setInterpolator(UiMotion.enter())
                        .withEndAction(() -> shutter.animate().scaleX(1f).scaleY(1f)
                                .setDuration(UiMotion.duration(this, UiMotion.CONTROL_MS))
                                .setInterpolator(UiMotion.spring())
                                .withEndAction(() -> shutter.setEnabled(true)).start())
                        .start();
                takePhoto();
            }
        });
        bottomBar.addView(shutter, new LinearLayout.LayoutParams(dp(74), dp(74)));

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.BOTTOM;
        root.addView(bottomBar, lp);
    }

    private void buildConfirmLayer() {
        confirmLayer = new FrameLayout(this);
        confirmLayer.setBackgroundColor(Color.BLACK);
        confirmLayer.setVisibility(View.GONE);

        confirmImage = new ImageView(this);
        confirmImage.setScaleType(ImageView.ScaleType.FIT_CENTER);
        confirmLayer.addView(confirmImage, match());

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER);
        actions.setPadding(dp(22), dp(18), dp(22), dp(30));

        TextView retake = actionButton("重拍", false);
        retake.setOnClickListener(v -> retake());
        LinearLayout.LayoutParams retakeLp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        retakeLp.rightMargin = dp(10);
        actions.addView(retake, retakeLp);

        TextView use = actionButton("使用这张", true);
        use.setOnClickListener(v -> finishWithShot());
        actions.addView(use, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.BOTTOM;
        confirmLayer.addView(actions, lp);

        root.addView(confirmLayer, match());
    }

    private TextView actionButton(String text, boolean primary) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        tv.setGravity(Gravity.CENTER);
        tv.setPadding(0, dp(13), 0, dp(13));
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(999));
        if (primary) {
            bg.setColor(0xFFE28BA6);
            bg.setStroke(dp(1), 0x9EFFFFFF);
            tv.setTextColor(Color.WHITE);
        } else {
            bg.setColor(0xAAFFFFFF);
            bg.setStroke(dp(1), 0x9EFFFFFF);
            tv.setTextColor(0xFF2E2A38);
        }
        GradientDrawable mask = new GradientDrawable();
        mask.setColor(Color.WHITE);
        mask.setCornerRadius(dp(999));
        tv.setBackground(new RippleDrawable(
                ColorStateList.valueOf(primary ? 0x44FFFFFF : 0x24C96F90), bg, mask));
        return tv;
    }

    private View circleButton(int iconRes, String desc) {
        FrameLayout box = new FrameLayout(this);
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(0xAAFFFFFF);
        bg.setStroke(dp(1), 0x9EFFFFFF);
        GradientDrawable mask = new GradientDrawable();
        mask.setShape(GradientDrawable.OVAL);
        mask.setColor(Color.WHITE);
        box.setBackground(new RippleDrawable(
                ColorStateList.valueOf(0x29C96F90), bg, mask));
        box.setContentDescription(desc);

        ImageView icon = new ImageView(this);
        icon.setImageResource(iconRes);
        icon.setColorFilter(0xFF2E2A38);
        box.addView(icon, new FrameLayout.LayoutParams(dp(20), dp(20), Gravity.CENTER));
        return box;
    }

    // ------------------------------------------------------------------
    // 相机
    // ------------------------------------------------------------------

    private void startCamera() {
        final ListenableFuture<ProcessCameraProvider> future =
                ProcessCameraProvider.getInstance(this);
        future.addListener(() -> {
            try {
                cameraProvider = future.get();
                bindUseCases();
            } catch (Exception e) {
                finishWithError("相机启动失败");
            }
        }, ContextCompat.getMainExecutor(this));
    }

    private void bindUseCases() {
        if (cameraProvider == null) {
            return;
        }
        try {
            CameraSelector available = new CameraSelector.Builder().requireLensFacing(lensFacing).build();
            if (!cameraProvider.hasCamera(available)) {
                int fallback = lensFacing == CameraSelector.LENS_FACING_BACK
                        ? CameraSelector.LENS_FACING_FRONT : CameraSelector.LENS_FACING_BACK;
                CameraSelector alternative = new CameraSelector.Builder().requireLensFacing(fallback).build();
                if (!cameraProvider.hasCamera(alternative)) {
                    finishWithError("当前设备没有可用摄像头");
                    return;
                }
                lensFacing = fallback;
            }
            Preview preview = new Preview.Builder().build();
            preview.setSurfaceProvider(previewView.getSurfaceProvider());

            imageCapture = new ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                    .setTargetRotation(getWindowManager().getDefaultDisplay().getRotation())
                    .build();

            CameraSelector selector = new CameraSelector.Builder()
                    .requireLensFacing(lensFacing)
                    .build();

            cameraProvider.unbindAll();
            camera = cameraProvider.bindToLifecycle(this, selector, preview, imageCapture);

            if (flashIcon != null) {
                boolean hasFlash = camera.getCameraInfo().hasFlashUnit();
                flashIcon.setAlpha(hasFlash ? 1f : 0.35f);
                flashIcon.setColorFilter(flashOn ? 0xFFFFB347 : 0xFF2E2A38);
            }
            previewView.setOnTouchListener(this::onPreviewTouch);
        } catch (Exception e) {
            finishWithError("当前设备无法打开相机");
        }
    }

    private boolean onPreviewTouch(View view, MotionEvent event) {
        if (event.getAction() != MotionEvent.ACTION_UP || camera == null) {
            return true;
        }
        float x = event.getX();
        float y = event.getY();

        MeteringPointFactory factory = previewView.getMeteringPointFactory();
        MeteringPoint point = factory.createPoint(x, y);
        FocusMeteringAction action = new FocusMeteringAction.Builder(
                point, FocusMeteringAction.FLAG_AF | FocusMeteringAction.FLAG_AE)
                .setAutoCancelDuration(3, TimeUnit.SECONDS)
                .build();
        try {
            camera.getCameraControl().startFocusAndMetering(action);
        } catch (Exception ignored) {
        }

        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) focusRing.getLayoutParams();
        lp.leftMargin = Math.round(x - dp(31));
        lp.topMargin = Math.round(y - dp(31));
        focusRing.setLayoutParams(lp);
        focusRing.animate().cancel();
        focusRing.setAlpha(1f);
        focusRing.animate().alpha(0f).setDuration(UiMotion.duration(this, 650))
                .setStartDelay(UiMotion.duration(this, 250)).start();
        return true;
    }

    private void takePhoto() {
        if (imageCapture == null || capturing) {
            return;
        }
        capturing = true;

        File dir = new File(getCacheDir(), "shots");
        if (!dir.exists() && !dir.mkdirs()) {
            capturing = false;
            toast("无法创建临时文件");
            return;
        }
        final File capturedFile = new File(dir, "shot_" + System.currentTimeMillis() + ".jpg");
        shotFile = capturedFile;
        final int request = ++captureSequence;

        ImageCapture.OutputFileOptions options =
                new ImageCapture.OutputFileOptions.Builder(capturedFile).build();
        imageCapture.takePicture(options, ContextCompat.getMainExecutor(this),
                new ImageCapture.OnImageSavedCallback() {
                    @Override
                    public void onImageSaved(ImageCapture.OutputFileResults outputFileResults) {
                        if (!isCurrentCapture(capturedFile, request)) return;
                        showConfirm(capturedFile, request);
                    }

                    @Override
                    public void onError(ImageCaptureException exception) {
                        if (!isCurrentCapture(capturedFile, request)) return;
                        capturing = false;
                        toast("拍照失败，请重试");
                    }
                });
    }

    private boolean isCurrentCapture(File file, int request) {
        return request == captureSequence && file.equals(shotFile)
                && !isFinishing() && !isDestroyed();
    }

    private void showConfirm(File file, int request) {
        // Keep capture busy until decoding finishes, so a second shutter cannot replace this shot.
        confirmTask = io.submit(() -> {
            Bitmap bitmap = decodeSampled(file, 1600);
            runOnUiThread(() -> {
                if (!isCurrentCapture(file, request)) {
                    if (bitmap != null) bitmap.recycle();
                    return;
                }
                confirmTask = null;
                capturing = false;
                if (bitmap == null) {
                    finishWithError("照片读取失败");
                    return;
                }
                confirmImage.setImageBitmap(bitmap);
                confirmLayer.animate().cancel();
                confirmLayer.setTranslationY(dp(8));
                confirmLayer.setAlpha(0f);
                confirmLayer.setVisibility(View.VISIBLE);
                confirmLayer.animate().alpha(1f).translationY(0)
                        .setDuration(UiMotion.duration(this, UiMotion.PANEL_MS))
                        .setInterpolator(UiMotion.enter()).start();
                hideCameraControls(topBar);
                hideCameraControls(bottomBar);
            });
        });
    }

    private void cancelConfirmTask() {
        captureSequence++;
        if (confirmTask != null) {
            confirmTask.cancel(true);
            confirmTask = null;
        }
    }

    private void retake() {
        cancelConfirmTask();
        capturing = false;
        confirmLayer.animate().cancel();
        confirmLayer.animate().alpha(0f).translationY(dp(8))
                .setDuration(UiMotion.duration(this, UiMotion.FAST_MS))
                .setInterpolator(UiMotion.standard())
                .withEndAction(() -> {
                    confirmLayer.setVisibility(View.GONE);
                    confirmImage.setImageDrawable(null);
                    confirmLayer.setAlpha(1f);
                    confirmLayer.setTranslationY(0f);
                }).start();
        if (shotFile != null && shotFile.exists()) {
            //noinspection ResultOfMethodCallIgnored
            shotFile.delete();
        }
        shotFile = null;
        showCameraControls(topBar);
        showCameraControls(bottomBar);
    }

    private void hideCameraControls(View controls) {
        controls.animate().cancel();
        controls.animate().alpha(0f).setDuration(UiMotion.duration(this, UiMotion.FAST_MS))
                .setInterpolator(UiMotion.standard())
                .withEndAction(() -> controls.setVisibility(View.GONE)).start();
    }

    private void showCameraControls(View controls) {
        controls.animate().cancel();
        controls.setAlpha(0f);
        controls.setVisibility(View.VISIBLE);
        controls.animate().alpha(1f).setDuration(UiMotion.duration(this, UiMotion.CONTROL_MS))
                .setInterpolator(UiMotion.enter()).start();
    }

    private void toggleFlash() {
        if (camera == null || !camera.getCameraInfo().hasFlashUnit()) {
            toast("当前摄像头没有闪光灯");
            return;
        }
        flashOn = !flashOn;
        camera.getCameraControl().enableTorch(flashOn);
        if (flashIcon != null) {
            flashIcon.setColorFilter(flashOn ? 0xFFFFB347 : 0xFF2E2A38);
        }
    }

    private void switchCamera() {
        if (cameraProvider == null || capturing) return;
        int nextLens = lensFacing == CameraSelector.LENS_FACING_BACK
                ? CameraSelector.LENS_FACING_FRONT
                : CameraSelector.LENS_FACING_BACK;
        CameraSelector selector = new CameraSelector.Builder().requireLensFacing(nextLens).build();
        try {
            if (!cameraProvider.hasCamera(selector)) {
                toast("当前设备没有另一侧摄像头");
                return;
            }
        } catch (Exception error) {
            toast("暂时无法切换摄像头");
            return;
        }
        if (camera != null && camera.getCameraInfo().hasFlashUnit()) {
            camera.getCameraControl().enableTorch(false);
        }
        lensFacing = nextLens;
        flashOn = false;
        bindUseCases();
    }

    private Bitmap decodeSampled(File file, int maxSize) {
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
            int sample = 1;
            int longest = Math.max(bounds.outWidth, bounds.outHeight);
            while (longest / sample > maxSize) {
                sample *= 2;
            }
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            Bitmap bitmap = BitmapFactory.decodeFile(file.getAbsolutePath(), opts);
            if (bitmap == null) return null;
            return orientPreview(file, bitmap);
        } catch (Throwable t) {
            return null;
        }
    }

    private Bitmap orientPreview(File file, Bitmap bitmap) {
        try {
            ExifInterface exif = new ExifInterface(file.getAbsolutePath());
            int orientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION,
                    ExifInterface.ORIENTATION_NORMAL);
            android.graphics.Matrix matrix = new android.graphics.Matrix();
            switch (orientation) {
                case ExifInterface.ORIENTATION_FLIP_HORIZONTAL: matrix.setScale(-1, 1); break;
                case ExifInterface.ORIENTATION_ROTATE_180: matrix.setRotate(180); break;
                case ExifInterface.ORIENTATION_FLIP_VERTICAL: matrix.setScale(1, -1); break;
                case ExifInterface.ORIENTATION_TRANSPOSE:
                    matrix.setRotate(90); matrix.postScale(-1, 1); break;
                case ExifInterface.ORIENTATION_ROTATE_90: matrix.setRotate(90); break;
                case ExifInterface.ORIENTATION_TRANSVERSE:
                    matrix.setRotate(-90); matrix.postScale(-1, 1); break;
                case ExifInterface.ORIENTATION_ROTATE_270: matrix.setRotate(-90); break;
                default: return bitmap;
            }
            Bitmap rotated = Bitmap.createBitmap(bitmap, 0, 0,
                    bitmap.getWidth(), bitmap.getHeight(), matrix, true);
            if (rotated != bitmap) bitmap.recycle();
            return rotated;
        } catch (Exception error) {
            return bitmap;
        }
    }

    private void cleanupOldShots() {
        io.execute(() -> {
            File dir = new File(getCacheDir(), "shots");
            File[] files = dir.listFiles();
            if (files == null) {
                return;
            }
            long cutoff = System.currentTimeMillis() - 24L * 60 * 60 * 1000;
            for (File f : files) {
                if (f.lastModified() < cutoff) {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                }
            }
        });
    }

    // ------------------------------------------------------------------
    // 结果 / 权限 / 系统栏
    // ------------------------------------------------------------------

    private void finishWithShot() {
        if (shotFile == null || !shotFile.exists()) {
            finishWithCancel();
            return;
        }
        Uri uri = FileProvider.getUriForFile(this,
                getPackageName() + ".fileprovider", shotFile);
        Intent data = new Intent();
        data.setData(uri);
        data.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        setResult(RESULT_OK, data);
        finish();
    }

    private void finishWithCancel() {
        setResult(RESULT_CANCELED);
        finish();
    }

    private void finishWithError(String message) {
        Intent data = new Intent();
        data.putExtra(EXTRA_ERROR, message);
        setResult(RESULT_CANCELED, data);
        toast(message);
        finish();
    }

    private boolean hasCameraPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true;
        }
        return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_CAMERA_PERM) {
            return;
        }
        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            startCamera();
        } else {
            finishWithError("没有相机权限");
        }
    }

    private void applyFullscreen() {
        Window window = getWindow();
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
            WindowInsetsController c = window.getDecorView().getWindowInsetsController();
            if (c != null) {
                c.setSystemBarsAppearance(0,
                        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
            }
        } else {
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    private void applyInsets() {
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int top;
            int bottom;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                top = bars.top;
                bottom = bars.bottom;
            } else {
                top = insets.getSystemWindowInsetTop();
                bottom = insets.getSystemWindowInsetBottom();
            }
            topBar.setPadding(dp(16), top + dp(10), dp(16), dp(10));
            bottomBar.setPadding(0, dp(10), 0, bottom + dp(22));
            if (confirmLayer != null && confirmLayer.getChildCount() > 1) {
                View actions = confirmLayer.getChildAt(1);
                actions.setPadding(dp(22), dp(18), dp(22), bottom + dp(26));
            }
            return insets;
        });
        root.requestApplyInsets();
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void toast(String text) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show();
    }

    private static FrameLayout.LayoutParams match() {
        return new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    @Override
    protected void onDestroy() {
        cancelConfirmTask();
        io.shutdownNow();
        if (cameraProvider != null) {
            cameraProvider.unbindAll();
        }
        super.onDestroy();
    }

    /** 三分构图网格，帮助拍正文字。 */
    private static class GridOverlay extends View {
        private final Paint paint = new Paint();

        GridOverlay(Context context) {
            super(context);
            paint.setColor(0x33FFFFFF);
            paint.setStrokeWidth(1f);
            setWillNotDraw(false);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            int w = getWidth();
            int h = getHeight();
            canvas.drawLine(w / 3f, 0, w / 3f, h, paint);
            canvas.drawLine(w * 2f / 3f, 0, w * 2f / 3f, h, paint);
            canvas.drawLine(0, h / 3f, w, h / 3f, paint);
            canvas.drawLine(0, h * 2f / 3f, w, h * 2f / 3f, paint);
        }
    }
}
