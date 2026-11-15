package ink.jian.translate;

import android.view.animation.Interpolator;
import android.view.animation.OvershootInterpolator;
import android.view.animation.PathInterpolator;
import android.content.Context;
import android.provider.Settings;

final class UiMotion {
    static final long FAST_MS = 140L;
    static final long CONTROL_MS = 220L;
    static final long PANEL_MS = 280L;
    static final long DIALOG_MS = 240L;
    static final long MODEL_MS = 420L;

    private UiMotion() {}

    static Interpolator standard() {
        return new PathInterpolator(0.22f, 0.8f, 0.28f, 1f);
    }

    static Interpolator enter() {
        return new PathInterpolator(0.18f, 0.8f, 0.22f, 1f);
    }

    static Interpolator spring() {
        return new OvershootInterpolator(0.22f);
    }

    static long duration(Context context, long defaultDuration) {
        float animatorScale = settingScale(context, Settings.Global.ANIMATOR_DURATION_SCALE);
        float transitionScale = settingScale(context, Settings.Global.TRANSITION_ANIMATION_SCALE);
        float scale = Math.min(animatorScale, transitionScale);
        return Math.round(defaultDuration * Math.max(0f, scale));
    }

    private static float settingScale(Context context, String setting) {
        try {
            return Math.max(0f, Settings.Global.getFloat(context.getContentResolver(), setting, 1f));
        } catch (RuntimeException ignored) {
            return 1f;
        }
    }
}
