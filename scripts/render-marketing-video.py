"""Render Jian's 52-second silent film with restrained kinetic typography.

All editorial input/output is inside the repository. The existing Windows font
resource used by the first cut is retained; no network or speech service is used.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
VIDEO = ROOT / "output" / "video"
BUILD = VIDEO / ".jian_build" / "kinetic-type"
MOVIE = VIDEO / "笺-从选中到读懂-文字艺术版.mp4"
SRT = VIDEO / "笺-从选中到读懂-文字艺术版.srt"
W, H, FPS, SECONDS = 1920, 1080, 24, 52
FONT = "C:/WINDOWS/Fonts/msyh.ttc"
INK = (29, 31, 35)
MUTED = (101, 104, 110)
WHITE = (245, 245, 242)
RESAMPLE = Image.Resampling.LANCZOS


@dataclass(frozen=True)
class Cue:
    start: float
    end: float
    text: str


CUES = (
    Cue(0, 4, "有时，不懂的只是一句。"),
    Cue(4, 10, "你正在读一段外文。"),
    Cue(10, 16, "选中它。"),
    Cue(16, 22, "译文，安静地出现在眼前。"),
    Cue(22, 30, "原文与译文，同屏呈现。"),
    Cue(30, 37, "只需要一瞬间。"),
    Cue(37, 44, "看懂之后，继续读下去。"),
    Cue(44, 52, "从选中，到读懂。"),
)


def clamp(p: float) -> float:
    return max(0.0, min(1.0, p))


def ease(p: float) -> float:
    p = clamp(p)
    return p * p * (3 - 2 * p)


def lerp(a: float, b: float, p: float) -> float:
    return a + (b - a) * p


@lru_cache(maxsize=32)
def typeface(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT, size)


@lru_cache(maxsize=96)
def text_mask(text: str, size: int, tracking: int = 0) -> Image.Image:
    face = typeface(size)
    measuring = ImageDraw.Draw(Image.new("L", (1, 1)))
    advances = [measuring.textlength(c, font=face) for c in text]
    width = math.ceil(sum(advances) + max(0, len(text) - 1) * tracking)
    mask = Image.new("L", (width + 10, math.ceil(size * 1.30)))
    draw = ImageDraw.Draw(mask)
    x = 2.0
    for char, advance in zip(text, advances):
        draw.text((x, size * .90), char, font=face, fill=255, anchor="ls")
        x += advance + tracking
    return mask


def text_width(text: str, size: int, tracking: int = 0) -> int:
    return text_mask(text, size, tracking).width


def put_type(
    target: Image.Image,
    text: str,
    xy: tuple[float, float],
    size: int,
    *,
    color: tuple[int, int, int] = INK,
    opacity: float = 1,
    tracking: int = 0,
    progress: float = 1,
    stagger: bool = False,
    scale: float = 1,
    clip: tuple[int, int, int, int] | None = None,
) -> tuple[int, int, int, int]:
    """Set one text run. Stagger uses fixed glyph slots, never relays out a line."""
    mask = text_mask(text, size, tracking)
    if stagger and progress < 1:
        mask = Image.new("L", mask.size)
        draw = ImageDraw.Draw(mask)
        face = typeface(size)
        x = 0.0
        for i, char in enumerate(text):
            amount = clamp(progress * (len(text) + 2) - i)
            if amount > 0:
                draw.text((round(x) + 2, size * .90), char, font=face,
                          fill=round(255 * ease(amount)), anchor="ls")
            x += draw.textlength(char, font=face) + tracking
    elif progress < 1:
        mask = mask.copy()
        ImageDraw.Draw(mask).rectangle(
            (0, round(mask.height * clamp(progress)), mask.width, mask.height), fill=0
        )
    if abs(scale - 1) > 0.001:
        mask = mask.resize((max(1, round(mask.width * scale)), max(1, round(mask.height * scale))), RESAMPLE)
    if opacity < 1:
        mask = mask.point(lambda a: round(a * clamp(opacity)))
    x, y = round(xy[0]), round(xy[1])
    bounds = (x, y, x + mask.width, y + mask.height)
    if clip is not None:
        left, top, right, bottom = clip
        ix0, iy0 = max(x, left), max(y, top)
        ix1, iy1 = min(x + mask.width, right), min(y + mask.height, bottom)
        if ix1 <= ix0 or iy1 <= iy0:
            return bounds
        mask = mask.crop((ix0 - x, iy0 - y, ix1 - x, iy1 - y))
        x, y = ix0, iy0
    target.paste(color, (x, y), mask)
    return bounds


@lru_cache(maxsize=1)
def background() -> Image.Image:
    xx = np.linspace(-1, 1, W, dtype=np.float32)[None, :]
    yy = np.linspace(-1, 1, H, dtype=np.float32)[:, None]
    gray = np.clip(248 - 3.8 * (xx * xx + yy * yy), 0, 255).astype(np.uint8)
    return Image.fromarray(np.stack((gray, gray, gray), axis=-1))


class Footage:
    """Decode the two explicitly supplied screen recordings once, in order."""

    def __init__(self):
        self.frames: dict[str, list[np.ndarray]] = {}
        self.fps: dict[str, float] = {}
        for key, filename in (
            ("selection", "屏幕录制 2026-11-18 215534.mp4"),
            ("popup", "屏幕录制 2026-11-18 220151.mp4"),
        ):
            capture = cv2.VideoCapture(str(VIDEO / filename))
            if not capture.isOpened():
                raise RuntimeError(f"Cannot open the supplied source {filename}")
            self.fps[key] = capture.get(cv2.CAP_PROP_FPS) or 30.0
            frames = []
            while True:
                ok, frame = capture.read()
                if not ok:
                    break
                frames.append(frame)
            capture.release()
            if not frames:
                raise RuntimeError(f"No frames in {filename}")
            self.frames[key] = frames

    @lru_cache(maxsize=48)
    def crop(self, key: str, frame_index: int, region: str) -> Image.Image:
        frames = self.frames[key]
        frame = frames[max(0, min(frame_index, len(frames) - 1))]
        rgb = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        if region == "reading":
            rgb = rgb.crop((16, 112, 871, 552))
        elif region == "full":
            rgb = rgb.crop((16, 114, 871, 558))
        elif region == "result":
            rgb = rgb.crop((360, 236, 865, 546))
        return rgb

    def image(self, key: str, time: float, region: str) -> Image.Image:
        return self.crop(key, round(time * self.fps[key]), region)


def product(
    canvas: Image.Image,
    image: Image.Image,
    rectangle: tuple[float, float, float, float],
    *,
    opacity: float = 1,
    foreground_text: Image.Image | None = None,
) -> None:
    """One actual screen crop, a quiet metallic edge and real soft shadow."""
    x, y, width, height = [round(v) for v in rectangle]
    if width < 10 or height < 10:
        return
    radius = 20
    layer = Image.new("RGBA", (width + 110, height + 110))
    shade = Image.new("RGBA", layer.size)
    ImageDraw.Draw(shade).rounded_rectangle((44, 49, width + 64, height + 69), radius + 3, fill=(19, 23, 29, 31))
    layer.alpha_composite(shade.filter(ImageFilter.GaussianBlur(20)))
    shell = Image.new("RGBA", (width, height))
    draw = ImageDraw.Draw(shell)
    draw.rounded_rectangle((0, 0, width - 1, height - 1), radius, fill=(186, 191, 196, 255))
    draw.rounded_rectangle((2, 2, width - 3, height - 3), radius - 1, fill=(244, 245, 245, 255))
    draw.rounded_rectangle((3, 3, width - 4, height - 4), radius - 2, outline=(255, 255, 255, 255), width=1)
    inner_w, inner_h = width - 16, height - 16
    inner = Image.new("RGB", (inner_w, inner_h), (249, 249, 249))
    ratio = min(inner_w / image.width, inner_h / image.height)
    resized = image.resize((round(image.width * ratio), round(image.height * ratio)), RESAMPLE)
    inner.paste(resized, ((inner_w - resized.width) // 2, (inner_h - resized.height) // 2))
    mask = Image.new("L", (inner_w, inner_h))
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, inner_w - 1, inner_h - 1), radius - 5, fill=255)
    shell.paste(inner, (8, 8), mask)
    layer.alpha_composite(shell, (54, 44))
    if opacity < 1:
        layer.putalpha(layer.getchannel("A").point(lambda a: round(a * clamp(opacity))))
    canvas.paste(layer, (x - 54, y - 44), layer)
    if foreground_text is not None:
        # Composited last, the device edge hides only part of the moving word.
        canvas.paste(foreground_text, (0, 0), foreground_text)


def segment(t: float) -> tuple[int, float]:
    for index, cue in enumerate(CUES):
        if cue.start <= t < cue.end:
            return index, t - cue.start
    return 7, max(0.0, t - 44)


def write_type_frame(t: float, footage: Footage) -> Image.Image:
    scene, u = segment(t)
    canvas = background().copy()
    fade_in = ease(u / 0.65)

    if scene == 0:
        # Three type levels, one gradual stagger and a long readable hold.
        put_type(canvas, "有时，", (322, 255), 44, color=MUTED, opacity=ease((u - .12) / .42))
        put_type(canvas, "不懂的", (312, lerp(374, 346, ease((u - .5) / .8))), 156,
                 progress=clamp((u - .5) / .85), stagger=True)
        put_type(canvas, "只是", (325, 560), 48, color=MUTED, opacity=ease((u - 1.35) / .42))
        put_type(canvas, "一句。", (447, 524), 132, progress=clamp((u - 1.45) / .70), stagger=True)
        return canvas

    if scene == 1:
        enter = ease(u / .9)
        exit_type = ease((u - 4.65) / .65)
        tx = lerp(180, 144, enter) - exit_type * 80
        put_type(canvas, "你正在读", (tx, 328), 44, color=MUTED, opacity=fade_in * (1 - exit_type))
        put_type(canvas, "一段", (tx - 5, 414), 96, progress=clamp((u - .2) / .55), opacity=1-exit_type)
        put_type(canvas, "外文。", (tx - 8, 539), 132, progress=clamp((u - .48) / .65), stagger=True, opacity=1-exit_type)
        image = footage.image("selection", min(.62, u * .14), "reading")
        # The panel glides over the final few pixels of the headline only at entry.
        product(canvas, image, (lerp(1900, 782, enter), 260, 1005, 540))
        return canvas

    if scene == 2:
        # The word is enlarged once. No perpetual zoom or per-character bounce.
        p = ease(u / .8)
        title_scale = lerp(.92, 1, p)
        put_type(canvas, "选中它。", (164, lerp(494, 469, p)), 156,
                 scale=title_scale, progress=clamp(u / .75), stagger=True)
        image = footage.image("selection", min(1.15, .55 + u * .12), "reading")
        panel_x = lerp(665, 934, ease((u - .10) / 1.10))
        product(canvas, image, (panel_x, 304, 836, 474))
        # Brief half occlusion is resolved by 1.2s; the sentence then reads whole.
        return canvas

    if scene == 3:
        p = ease(u / .9)
        # One baseline mask starts at half-height, then reveals the whole noun.
        headline_y = lerp(351, 324, p)
        clip_y = round(headline_y + lerp(68, 174, ease((u - .5) / .65)))
        put_type(canvas, "译文，", (153, headline_y), 132,
                 clip=(120, 286, 730, clip_y), opacity=fade_in)
        put_type(canvas, "安静地", (164, 503), 54, color=MUTED, opacity=ease((u - 1.05) / .5))
        put_type(canvas, "出现在眼前。", (164, 587), 54,
                 progress=clamp((u - 1.32) / .7), stagger=True)
        image = footage.image("popup", min(3.4, .67 + u * .92), "result")
        product(canvas, image, (lerp(1810, 830, p), 253, 946, 583))
        return canvas

    if scene == 4:
        p = ease(u / .9)
        image = footage.image("popup", 3.45, "full")
        product(canvas, image, (lerp(170, 118, p), 281, 1044, 558))
        tx = lerp(1314, 1254, p)
        put_type(canvas, "原文与译文，", (tx + 3, 334), 44, color=MUTED, opacity=fade_in)
        put_type(canvas, "同屏", (tx, 427), 132, progress=clamp((u - .25) / .60), stagger=True)
        put_type(canvas, "呈现。", (tx, 583), 116, progress=clamp((u - .65) / .65), stagger=True)
        return canvas

    if scene == 5:
        # A typography-dominant pause. The screen arrives only once to occlude
        # the lower strokes of the large word, then settles to the right.
        p = ease(u / .80)
        put_type(canvas, "只需要", (181, 305), 48, color=MUTED, opacity=fade_in)
        put_type(canvas, "一瞬间。", (164, 421), 156, scale=lerp(.94, 1, p),
                 progress=clamp((u - .18) / .70), stagger=True)
        q = ease((u - 2.6) / 1.05)
        slide = ease((u - 3.65) / 1.0)
        image = footage.image("popup", 3.45, "result")
        # The card crosses just the last word at the beginning of its travel.
        product(canvas, image, (lerp(580, 1072, slide), lerp(1130, 520, q), 712, 440))
        return canvas

    if scene == 6:
        p = ease(u / .92)
        exit_type = ease((u - 4.7) / .65)
        alpha = fade_in * (1-exit_type)
        put_type(canvas, "看懂之后，", (158, 332), 44, color=MUTED, opacity=alpha)
        put_type(canvas, "继续", (lerp(280, 151, p), 421), 116, opacity=alpha)
        put_type(canvas, "读下去。", (lerp(280, 151, p), 566), 116, opacity=alpha,
                 progress=clamp((u - .32) / .65), stagger=True)
        image = footage.image("popup", 3.45, "result")
        product(canvas, image, (lerp(875, 826, p), 285, 950, 586))
        return canvas

    # Brand and the short tagline are the only elements in the final composition.
    canvas = Image.new("RGB", (W, H), (10, 11, 13))
    p = ease(u / .9)
    name = "笺"
    name_w = text_width(name, 132)
    put_type(canvas, name, ((W - name_w) / 2, lerp(356, 330, p)), 132,
             color=WHITE, opacity=p)
    line = "从选中，到读懂。"
    width = text_width(line, 48, 4)
    put_type(canvas, line, ((W - width) / 2, 546), 48, color=(204, 204, 201), tracking=4,
             progress=clamp((u - 1.15) / 1.05), stagger=True)
    return canvas


def scene_transition(t: float, footage: Footage) -> Image.Image:
    scene, u = segment(t)
    image = write_type_frame(t, footage)
    # A single moving occlusion joins scenes; no additional sub-shots are added.
    if scene and u < .75:
        previous = write_type_frame(CUES[scene].start - 1/FPS, footage)
        p = ease(u / .75)
        edge = round((W + 64) * p - 32)
        alpha = np.clip((edge - np.arange(W, dtype=np.float32)) / 28 + 1, 0, 1)
        a = alpha[None, :, None]
        mixed = np.asarray(previous, dtype=np.float32) * (1-a) + np.asarray(image, dtype=np.float32) * a
        image = Image.fromarray(np.clip(mixed, 0, 255).astype(np.uint8))
    return image


def stamp(seconds: float) -> str:
    whole = round(seconds * 1000)
    hh, rest = divmod(whole, 3_600_000)
    mm, rest = divmod(rest, 60_000)
    ss, ms = divmod(rest, 1000)
    return f"{hh:02}:{mm:02}:{ss:02},{ms:03}"


def save_subtitles() -> None:
    text = "\n\n".join(f"{i}\n{stamp(c.start)} --> {stamp(c.end)}\n{c.text}" for i, c in enumerate(CUES, 1))
    SRT.write_text(text + "\n", encoding="utf-8-sig")


def export_previews(footage: Footage) -> None:
    times = (.85, 2.8, 5.8, 10.6, 12.5, 16.55, 18.6, 25, 31.5, 33.55, 34.2, 39.4, 46.6)
    tiles = Image.new("RGB", (4 * 480, 4 * 270), (235, 235, 235))
    for i, t in enumerate(times):
        frame = scene_transition(t, footage)
        frame.save(BUILD / f"preview-{t:05.2f}.jpg", quality=93)
        tiles.paste(frame.resize((480, 270), RESAMPLE), ((i % 4)*480, (i // 4)*270))
    tiles.save(BUILD / "typography-contact-sheet.jpg", quality=94)
    print("Saved 13 visual inspection frames and the typography contact sheet.", flush=True)


def validate() -> None:
    assert len(CUES) == 8
    assert CUES[0].start == 0 and CUES[-1].end == SECONDS
    assert all(CUES[i].end == CUES[i + 1].start for i in range(len(CUES) - 1))
    assert sum(c.end-c.start for c in CUES) * FPS == 1248
    # All complete editorial text must fit the visible safe area once settled.
    assert text_width("选中它。", 156) < 750
    assert text_width("出现在眼前。", 54) < 650
    assert text_width("从选中，到读懂。", 48, 4) < 900
    print("PASS: eight continuous cues; 52s; 24fps; 1248 frames; type bounds fit.", flush=True)


def render(footage: Footage) -> None:
    temp = BUILD / "kinetic-24fps.rendering.mp4"
    log_path = BUILD / "encoder.log"
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(
            ["ffmpeg", "-y", "-v", "warning", "-f", "rawvideo", "-pixel_format", "rgb24",
             "-video_size", f"{W}x{H}", "-framerate", str(FPS), "-i", "pipe:0", "-an",
             "-c:v", "libx264", "-preset", "fast", "-crf", "17", "-threads", "4",
             "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(temp)],
            stdin=subprocess.PIPE, stderr=log,
        )
        assert process.stdin is not None
        try:
            for index in range(FPS * SECONDS):
                process.stdin.write(np.asarray(scene_transition(index / FPS, footage)).tobytes())
                if index % (FPS * 8) == 0:
                    print(f"Rendering {index/FPS:.0f}/{SECONDS}s", flush=True)
            process.stdin.close()
        except BaseException:
            process.stdin.close()
            process.terminate()
            process.wait()
            raise
        code = process.wait()
    if code != 0:
        raise RuntimeError(f"Video encoder exited {code}; inspect {log_path.name}")
    # Publish only once a complete file is available; keep the previous silent cut.
    temp.replace(MOVIE)
    save_subtitles()
    metadata = {"duration": SECONDS, "fps": FPS, "frames": FPS*SECONDS, "size": [W, H],
                "audio": False, "cues": [c.__dict__ for c in CUES],
                "animation": "one main entry per scene; holds; no fixed lower caption bar"}
    (BUILD / "render-metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Rendered kinetic typography film and matching SRT.", flush=True)


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--render", action="store_true")
    args = parser.parse_args()
    BUILD.mkdir(parents=True, exist_ok=True)
    validate()
    if args.preview or args.render:
        footage = Footage()
        if args.preview:
            export_previews(footage)
        if args.render:
            render(footage)


if __name__ == "__main__":
    main()
