"""Create a minimal 16:9 Jian cover using its actual translation popup."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
VIDEO = ROOT / "output" / "video"
BUILD = VIDEO / ".jian_build" / "cover"
SOURCE = VIDEO / "屏幕录制 2026-11-18 220151.mp4"
TIME = 3.4
CROP = (377, 246, 857, 537)
SCALE = 2
WIDTH, HEIGHT = 1920, 1080

# Keep the same local typeface as the completed film, without invoking a renderer.
spec = importlib.util.spec_from_file_location(
    "jian_cover_typography", ROOT / "scripts" / "render-marketing-video.py"
)
if spec is None or spec.loader is None:
    raise RuntimeError("The existing typography helper is unavailable")
art = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = art
spec.loader.exec_module(art)


def units(value: float) -> int:
    return round(value * SCALE)


def label(image: Image.Image, text: str, point: tuple[int, int], size: int, color: tuple[int, int, int]) -> tuple[int, int, int, int]:
    face = art.typeface(units(size))
    draw = ImageDraw.Draw(image)
    xy = (units(point[0]), units(point[1]))
    bounds = draw.textbbox(xy, text, font=face, anchor="lt")
    draw.text(xy, text, font=face, fill=color, anchor="lt")
    return bounds


def read_popup() -> Image.Image:
    capture = cv2.VideoCapture(str(SOURCE))
    if not capture.isOpened():
        raise RuntimeError("The supplied popup recording is unavailable")
    capture.set(cv2.CAP_PROP_POS_MSEC, TIME * 1000)
    ok, frame = capture.read()
    capture.release()
    if not ok:
        raise RuntimeError("The selected translation-popup moment cannot be read")
    return Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)).crop(CROP)


def create() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    width, height = units(WIDTH), units(HEIGHT)
    x = np.linspace(-1, 1, width, dtype=np.float32)[None, :]
    y = np.linspace(-1, 1, height, dtype=np.float32)[:, None]
    light = np.clip(248.0 - 3.6 * (x * x + y * y) - 1.0 * y, 0, 255).astype(np.uint8)
    canvas = Image.fromarray(np.stack((light, light, light), axis=-1))
    bounds = []
    bounds.append(label(canvas, "笺", (151, 182), 58, (40, 43, 49)))
    bounds.append(label(canvas, "翻译工具", (244, 205), 25, (125, 128, 134)))
    bounds.append(label(canvas, "从选中，", (142, 355), 128, (29, 31, 36)))
    bounds.append(label(canvas, "到读懂。", (142, 520), 128, (29, 31, 36)))

    popup = read_popup()
    panel_width = units(895)
    panel_height = round(panel_width * popup.height / popup.width)
    popup = popup.resize((panel_width, panel_height), Image.Resampling.LANCZOS)
    pad = units(64)
    inset = units(6)
    radius = units(26)
    layer = Image.new("RGBA", (panel_width + 2 * pad, panel_height + 2 * pad))
    shadow = Image.new("RGBA", layer.size)
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle(
        (pad - units(2), pad + units(10), pad + panel_width + units(7), pad + panel_height + units(20)),
        radius=radius, fill=(27, 32, 40, 37),
    )
    layer.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(units(25))))
    border = ImageDraw.Draw(layer)
    border.rounded_rectangle(
        (pad - inset, pad - inset, pad + panel_width + inset, pad + panel_height + inset),
        radius=radius + inset, fill=(185, 191, 199, 255),
    )
    border.rounded_rectangle(
        (pad - inset + units(1), pad - inset + units(1), pad + panel_width + inset - units(1), pad + panel_height + inset - units(1)),
        radius=radius + inset - units(1), fill=(251, 251, 250, 255),
    )
    mask = Image.new("L", popup.size)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, panel_width-1, panel_height-1), radius=radius, fill=255)
    layer.paste(popup, (pad, pad), mask)
    ImageDraw.Draw(layer).rounded_rectangle(
        (pad - inset + units(1), pad - inset + units(1), pad + panel_width + inset - units(1), pad + panel_height + inset - units(1)),
        radius=radius + inset - units(1), outline=(255, 255, 255, 210), width=units(1),
    )
    # The same single popup is the only visual object; no extra device or icon.
    panel_x, panel_y = units(872), units(278)
    canvas.paste(layer, (panel_x-pad, panel_y-pad), layer)

    high = VIDEO / "笺-宣传片封面-4K.png"
    normal = VIDEO / "笺-宣传片封面.png"
    jpeg = VIDEO / "笺-宣传片封面.jpg"
    canvas.save(high, optimize=True)
    full_hd = canvas.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
    full_hd.save(normal, optimize=True)
    full_hd.save(jpeg, quality=96, subsampling=0)
    thumbnail = full_hd.resize((320, 180), Image.Resampling.LANCZOS)
    thumbnail.save(BUILD / "thumbnail-320.jpg", quality=95, subsampling=0)
    thumbnail.resize((960, 540), Image.Resampling.NEAREST).save(BUILD / "thumbnail-readability.png")
    for bbox in bounds:
        if not (0 <= bbox[0] < bbox[2] <= width and 0 <= bbox[1] < bbox[3] <= height):
            raise RuntimeError(f"Cover type exceeds its safe area: {bbox}")
    if panel_x + panel_width + inset > width or panel_y + panel_height + inset > height:
        raise RuntimeError("Product popup exceeds the cover safe area")
    metadata = {
        "source_recording": SOURCE.name, "source_time_seconds": TIME,
        "popup_crop": list(CROP), "cover_size": [WIDTH, HEIGHT], "high_resolution_size": [width, height],
        "headline": "从选中，到读懂。", "brand": "笺", "category": "翻译工具",
        "style": "light gray, dark type, one real popup, subtle metal edge", "type_bounds_at_4k": bounds,
        "output_files": [normal.name, high.name, jpeg.name],
    }
    (BUILD / "cover-layout.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Wrote 1920x1080 PNG/JPEG cover and 3840x2160 PNG master", flush=True)
    print("PASS: title and single product popup remain within cover safe areas", flush=True)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    create()
