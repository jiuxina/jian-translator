/*
 * Runs the production Android inset listener against synthetic system/IME
 * insets. No device, signing material, preferences or user data are accessed.
 * Requires a local JDK; generated Java stays under the ignored .build folder.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const utf8 = new TextDecoder('utf-8', { fatal: true });
const source = utf8.decode(await readFile(path.join(root,
  'android/app/src/main/java/ink/jian/translate/MainActivity.java'))).replace(/\r\n/g, '\n');
const manifest = utf8.decode(await readFile(path.join(root,
  'android/app/src/main/AndroidManifest.xml')));
const start = source.indexOf('    private void applyInsets() {');
const end = source.indexOf('\n    // ------------------------------------------------------------------', start);
const flagsStart = source.indexOf('    private int systemUiFlags() {');
const flagsEnd = source.indexOf('    private void applyNativeAppearance(', flagsStart);
assert.ok(start >= 0 && end > start, 'The production Android inset listener is present');
assert.ok(flagsStart >= 0 && flagsEnd > flagsStart, 'The production system UI policy is present');
assert.match(manifest, /android:name="\.MainActivity"[\s\S]*?android:windowSoftInputMode="adjustNothing"/,
  'The Android window uses keyboard overlay instead of resizing or panning');
const onCreate = source.slice(source.indexOf('    protected void onCreate('),
  source.indexOf('    protected void onSaveInstanceState('));
assert.match(onCreate, /WindowCompat\.setDecorFitsSystemWindows\(getWindow\(\), false\)/,
  'The main root owns system-bar insets on both legacy and modern Android');
assert.match(onCreate, /setSystemUiVisibility\(mainWindowSystemUiFlags\(\)\)/,
  'Initial main-window flags keep the root behind the navigation bar');
const applyAppearance = source.slice(source.indexOf('    private void applyNativeAppearance('),
  source.indexOf('    private void applyPhotoSourceAppearance('));
assert.match(applyAppearance, /setSystemUiVisibility\(mainWindowSystemUiFlags\(\)\)/,
  'Live appearance changes preserve the main-window inset ownership');
assert.equal((source.match(/setSystemUiVisibility\(systemUiFlags\(\)\)/g) || []).length, 2,
  'The image-source dialog keeps its separate system-bar layout policy');

const fixture = `
public final class ImeInsetsContract {
    private final View root = new View();
    private final WebView webView = new WebView();
    private final NativeAppearance appearance = new NativeAppearance();
    private Insets decorMargins = Insets.NONE;

${source.slice(start, end)}
${source.slice(flagsStart, flagsEnd)}

    static final class NativeAppearance { boolean dark; }
    static final class Insets {
        static final Insets NONE = new Insets(0, 0, 0, 0);
        final int left, top, right, bottom;
        Insets(int left, int top, int right, int bottom) {
            this.left = left; this.top = top; this.right = right; this.bottom = bottom;
        }
        Insets union(Insets other) {
            return new Insets(Math.max(left, other.left), Math.max(top, other.top),
                    Math.max(right, other.right), Math.max(bottom, other.bottom));
        }
    }
    static class View {
        static final int SYSTEM_UI_FLAG_LAYOUT_STABLE = 1;
        static final int SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN = 2;
        static final int SYSTEM_UI_FLAG_LIGHT_STATUS_BAR = 4;
        static final int SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR = 8;
        static final int SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION = 16;
    }
    static final class FrameLayout {
        static final class LayoutParams {
            int leftMargin, topMargin, rightMargin, bottomMargin;
            void setMargins(int left, int top, int right, int bottom) {
                leftMargin = left; topMargin = top; rightMargin = right; bottomMargin = bottom;
            }
        }
    }
    static final class WebView extends View {
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams();
        int layoutWrites;
        Object getLayoutParams() { return params; }
        void setLayoutParams(FrameLayout.LayoutParams next) { params = next; layoutWrites++; }
    }
    interface OnApplyWindowInsetsListener {
        WindowInsetsCompat onApplyWindowInsets(View view, WindowInsetsCompat insets);
    }
    static final class ViewCompat {
        static OnApplyWindowInsetsListener listener;
        static void setOnApplyWindowInsetsListener(View view, OnApplyWindowInsetsListener next) {
            listener = next;
        }
        static void requestApplyInsets(View view) {}
    }
    static final class WindowInsetsCompat {
        static final class Type {
            static int systemBars() { return 1; }
            static int displayCutout() { return 2; }
            static int ime() { return 4; }
        }
        final Insets bars, visibleBars, cutout, ime;
        final boolean barsVisible;
        final int consumed;
        WindowInsetsCompat(Insets bars, Insets cutout, int keyboardHeight, boolean barsVisible) {
            this(bars, cutout, new Insets(0, 0, 0, keyboardHeight), barsVisible, 0);
        }
        WindowInsetsCompat(Insets bars, Insets cutout, Insets ime, boolean barsVisible, int consumed) {
            this(bars, barsVisible ? bars : Insets.NONE, cutout, ime, barsVisible, consumed);
        }
        WindowInsetsCompat(Insets bars, Insets visibleBars, Insets cutout, Insets ime,
                boolean barsVisible, int consumed) {
            this.bars = bars; this.cutout = cutout; this.ime = ime;
            this.visibleBars = visibleBars;
            this.barsVisible = barsVisible; this.consumed = consumed;
        }
        Insets getInsets(int types) { return insets(types, false); }
        Insets getInsetsIgnoringVisibility(int types) {
            if ((types & Type.ime()) != 0) throw new AssertionError("IME has no stable maximum inset");
            return insets(types, true);
        }
        private Insets insets(int types, boolean ignoreVisibility) {
            Insets result = Insets.NONE;
            int available = types & ~consumed;
            if ((available & Type.systemBars()) != 0 && (ignoreVisibility || barsVisible)) {
                // Legacy root stable insets remain available even after the
                // DecorView has consumed the visible navigation-bar inset.
                result = result.union(ignoreVisibility ? bars : visibleBars);
            }
            if ((available & Type.displayCutout()) != 0) result = result.union(cutout);
            if ((available & Type.ime()) != 0) result = result.union(ime);
            return result;
        }
        static final class Builder {
            final WindowInsetsCompat original;
            int consumed;
            Builder(WindowInsetsCompat original) { this.original = original; consumed = original.consumed; }
            Builder setInsets(int types, Insets value) {
                if (value != Insets.NONE) throw new AssertionError("Only handled insets should be consumed");
                consumed |= types;
                return this;
            }
            WindowInsetsCompat build() {
                return new WindowInsetsCompat(original.bars, original.visibleBars, original.cutout, original.ime,
                        original.barsVisible, consumed);
            }
        }
    }
    void dispatch(Insets bars, Insets cutout, int keyboardHeight, boolean barsVisible) {
        decorMargins = Insets.NONE;
        dispatch(new WindowInsetsCompat(bars, cutout, keyboardHeight, barsVisible));
    }
    void dispatchLegacyWindow(Insets bars, Insets cutout, int keyboardHeight,
            boolean barsVisible, int flags) {
        boolean reservesNavigation = (flags & View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION) == 0;
        decorMargins = reservesNavigation ? new Insets(bars.left, 0, bars.right, bars.bottom) : Insets.NONE;
        Insets visibleBars = reservesNavigation ? new Insets(0, bars.top, 0, 0) : bars;
        dispatch(new WindowInsetsCompat(bars, visibleBars, cutout,
                new Insets(0, 0, 0, keyboardHeight), barsVisible, 0));
    }
    void dispatch(WindowInsetsCompat insets) {
        WindowInsetsCompat forwarded = ViewCompat.listener.onApplyWindowInsets(root,
                insets);
        Insets remaining = forwarded.getInsets(WindowInsetsCompat.Type.systemBars()
                | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
        require(remaining.left == 0 && remaining.top == 0 && remaining.right == 0 && remaining.bottom == 0,
                "WebView must not apply the already handled system or keyboard insets again");
    }
    void margins(int left, int top, int right, int bottom) {
        FrameLayout.LayoutParams actual = webView.params;
        require(actual.leftMargin == left && actual.topMargin == top
                && actual.rightMargin == right && actual.bottomMargin == bottom,
                "The viewport must follow persistent system chrome only");
    }
    void totalMargins(int left, int top, int right, int bottom) {
        FrameLayout.LayoutParams actual = webView.params;
        require(actual.leftMargin + decorMargins.left == left
                && actual.topMargin + decorMargins.top == top
                && actual.rightMargin + decorMargins.right == right
                && actual.bottomMargin + decorMargins.bottom == bottom,
                "DecorView and WebView must reserve the system-bar safe area exactly once");
    }
    static void require(boolean result, String message) {
        if (!result) throw new AssertionError(message);
    }
    public static void main(String[] args) {
        ImeInsetsContract fixture = new ImeInsetsContract();
        fixture.applyInsets();
        Insets portraitBars = new Insets(0, 24, 0, 34);
        // Reproduce the legacy double-count before applying the main-window
        // policy: consumed visible nav insets still have a stable root inset.
        fixture.dispatchLegacyWindow(portraitBars, Insets.NONE, 0, true, fixture.systemUiFlags());
        fixture.totalMargins(0, 24, 0, 68);
        fixture.dispatchLegacyWindow(portraitBars, Insets.NONE, 0, true, fixture.mainWindowSystemUiFlags());
        fixture.margins(0, 24, 0, 34);
        fixture.totalMargins(0, 24, 0, 34);
        int firstLayout = fixture.webView.layoutWrites;
        for (int height : new int[] {360, 480, 280, 0}) {
            fixture.dispatchLegacyWindow(portraitBars, Insets.NONE, height, true,
                    fixture.mainWindowSystemUiFlags());
            fixture.margins(0, 24, 0, 34);
            fixture.totalMargins(0, 24, 0, 34);
            require(fixture.webView.layoutWrites == firstLayout,
                    "Opening, resizing and closing the keyboard must not request page layout");
        }
        fixture.dispatch(portraitBars, Insets.NONE, 420, false);
        fixture.margins(0, 24, 0, 34);
        require(fixture.webView.layoutWrites == firstLayout,
                "Transient bar visibility while the keyboard is open must not resize the page");
        Insets landscapeBars = new Insets(26, 0, 34, 0);
        fixture.dispatchLegacyWindow(landscapeBars, Insets.NONE, 420, true,
                fixture.mainWindowSystemUiFlags());
        fixture.margins(26, 0, 34, 0);
        fixture.totalMargins(26, 0, 34, 0);
        require(fixture.webView.layoutWrites == firstLayout + 1,
                "Rotation still updates the real persistent safe area");
        fixture.dispatch(portraitBars, new Insets(0, 48, 0, 0), 420, true);
        fixture.margins(0, 48, 0, 34);
        require(fixture.webView.layoutWrites == firstLayout + 2,
                "Display cutouts retain their safe-area protection");
        fixture.appearance.dark = true;
        require((fixture.mainWindowSystemUiFlags() & View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION) != 0,
                "Changing appearance must preserve the main window's edge-to-edge layout");
        require((fixture.systemUiFlags() & View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION) == 0,
                "The image-source dialog must retain its existing navigation-bar layout");
        System.out.println("Android IME overlay checks passed: stable viewport, legacy decor ownership, rotation and cutouts.");
    }
}
`;

const output = path.join(root, '.build/android-ime-contract');
await mkdir(output, { recursive: true });
const javaSource = path.join(output, 'ImeInsetsContract.java');
await writeFile(javaSource, fixture, 'utf8');
execFileSync(process.platform === 'win32' ? 'javac.exe' : 'javac',
  ['-encoding', 'UTF-8', '-d', output, javaSource], { stdio: 'pipe' });
const result = execFileSync(process.platform === 'win32' ? 'java.exe' : 'java',
  ['-cp', output, 'ImeInsetsContract'], { encoding: 'utf8' });
console.log(result.trim());
