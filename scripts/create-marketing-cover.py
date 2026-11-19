"""Create a softly illustrated 16:9 Jian cover with its real icon and popup."""

from __future__ import annotations

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
ICON = ROOT / "app" / "icon.png"
TYPE_ASSETS = ROOT / "scripts" / "assets" / "marketing-cover"
TIME = 3.4
CROP = (377, 246, 857, 537)
SCALE = 2
WIDTH, HEIGHT = 1920, 1080
HEADLINE = "超轻快的免费的开箱即用的大模型的划词翻译软件附送轻快手机app"
HEADLINE_LINES = (
    ("超轻快的免费的", (142, 240), 72, (64, 67, 73)),
    ("开箱即用的大模型的", (142, 330), 70, (64, 67, 73)),
    ("划词翻译软件", (135, 420), 110, (38, 35, 48)),
    ("附送轻快手机app", (146, 548), 62, (77, 80, 87)),
)

# Preserve the approved lettering with local alpha masks. Repositioning this
# cover does not require reading a system font or rerendering the video.
TYPE_DATA = json.loads((TYPE_ASSETS / "approved-type.json").read_text(encoding="utf-8"))


def units(value: float) -> int:
    return round(value * SCALE)


def label(image: Image.Image, text: str, point: tuple[int, int], size: int, color: tuple[int, int, int]) -> tuple[int, int, int, int]:
    matches = [item for item in TYPE_DATA["labels"] if item["text"] == text and item["size_at_1080p"] == size]
    if len(matches) != 1:
        raise RuntimeError(f"The approved cover lettering is unavailable: {text}")
    with Image.open(TYPE_ASSETS / "approved-type-mask.png") as atlas:
        mask = atlas.crop(matches[0]["bounds"]).convert("L")
    if SCALE != TYPE_DATA["scale"]:
        ratio = SCALE / TYPE_DATA["scale"]
        mask = mask.resize((round(mask.width*ratio), round(mask.height*ratio)), Image.Resampling.LANCZOS)
    xy = (units(point[0]), units(point[1]))
    bounds = (xy[0], xy[1], xy[0]+mask.width, xy[1]+mask.height)
    image.paste(color, bounds, mask)
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


def anime_background(canvas: Image.Image) -> Image.Image:
    """Keep the supplied character visible on the unobstructed right side."""
    icon = Image.open(ICON).convert("RGBA")
    portrait_size = units(1190)
    portrait = icon.resize((portrait_size, portrait_size), Image.Resampling.LANCZOS)
    data = np.asarray(portrait, dtype=np.float32)
    # Suppress the icon's white backing in the large version only. The small
    # foreground brand icon remains completely unchanged.
    illustration = np.clip((255-data[:, :, :3].min(axis=2))/70, 0, 1)
    alpha = data[:, :, 3]*illustration*.72
    portrait.putalpha(Image.fromarray(alpha.astype(np.uint8)))
    portrait = portrait.filter(ImageFilter.GaussianBlur(units(.5)))
    layer = Image.new("RGBA", canvas.size)
    layer.alpha_composite(portrait, (units(704), units(-40)))

    # A softly varying white veil keeps the copy legible while leaving the
    # illustration visible in the top, right and lower background margins.
    x = np.linspace(0, 1, canvas.width, dtype=np.float32)[None, :]
    left_protection = np.clip((.66-x)/.42, 0, 1)
    veil_alpha = np.broadcast_to((left_protection*154).astype(np.uint8), (canvas.height, canvas.width))
    veil = Image.new("RGBA", canvas.size, (252, 249, 253, 0))
    veil.putalpha(Image.fromarray(veil_alpha))
    result = canvas.convert("RGBA")
    result.alpha_composite(layer)
    result.alpha_composite(veil)
    return result.convert("RGB")


def brand_icon(canvas: Image.Image) -> None:
    icon = Image.open(ICON).convert("RGBA")
    icon = icon.resize((units(86), units(86)), Image.Resampling.LANCZOS)
    canvas.paste(icon, (units(145), units(90)), icon)


def create() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    width, height = units(WIDTH), units(HEIGHT)
    x = np.linspace(-1, 1, width, dtype=np.float32)[None, :]
    y = np.linspace(-1, 1, height, dtype=np.float32)[:, None]
    light = np.clip(248.0 - 3.6 * (x * x + y * y) - 1.0 * y, 0, 255).astype(np.uint8)
    pink = np.exp(-((x-.40)**2/.7 + (y+.60)**2/1.2))
    lavender = np.exp(-((x-.65)**2/.8 + (y-.45)**2/1.0))
    rgb = np.stack((light+pink*5, light-pink*2, light+lavender*5), axis=-1)
    canvas = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))
    canvas = anime_background(canvas)
    brand_icon(canvas)
    bounds = []
    bounds.append(label(canvas, "笺", (265, 107), 58, (40, 43, 49)))
    bounds.append(label(canvas, "翻译工具", (359, 133), 25, (125, 128, 134)))
    if "".join(line for line, _, _, _ in HEADLINE_LINES) != HEADLINE:
        raise RuntimeError("Cover line wrapping must preserve the exact requested wording")
    for line, point, size, color in HEADLINE_LINES:
        bounds.append(label(canvas, line, point, size, color))

    popup = read_popup()
    panel_width = units(600)
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
    # Put the smaller real popup below the copy; leave the character's face clear.
    panel_x, panel_y = units(142), units(650)
    canvas.paste(layer, (panel_x-pad, panel_y-pad), layer)

    for bbox in bounds:
        if not (0 <= bbox[0] < bbox[2] <= width and 0 <= bbox[1] < bbox[3] <= height):
            raise RuntimeError(f"Cover type exceeds its safe area: {bbox}")
    panel_bounds = (panel_x-inset, panel_y-inset, panel_x+panel_width+inset, panel_y+panel_height+inset)
    if not (0 <= panel_bounds[0] < panel_bounds[2] <= width and 0 <= panel_bounds[1] < panel_bounds[3] <= height):
        raise RuntimeError("Product popup exceeds the cover safe area")
    if any(bbox[3] + units(24) > panel_bounds[1] for bbox in bounds):
        raise RuntimeError("Cover copy leaves insufficient space above the product popup")
    if any(bbox[2] > units(900) for bbox in [*bounds, panel_bounds]):
        raise RuntimeError("Foreground content obstructs the character's right-side area")

    high = VIDEO / "笺-宣传片封面-4K.png"
    normal = VIDEO / "笺-宣传片封面.png"
    jpeg = VIDEO / "笺-宣传片封面.jpg"
    canvas.save(high, optimize=True)
    full_hd = canvas.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
    full_hd.save(normal, optimize=True)
    anime_cover = VIDEO / "笺-宣传片封面-二次元版.png"
    full_hd.save(anime_cover, optimize=True)
    full_hd.save(jpeg, quality=96, subsampling=0)
    thumbnail = full_hd.resize((320, 180), Image.Resampling.LANCZOS)
    thumbnail.save(BUILD / "thumbnail-320.jpg", quality=95, subsampling=0)
    thumbnail.resize((960, 540), Image.Resampling.NEAREST).save(BUILD / "thumbnail-readability.png")
    metadata = {
        "source_recording": SOURCE.name, "source_time_seconds": TIME,
        "popup_crop": list(CROP), "cover_size": [WIDTH, HEIGHT], "high_resolution_size": [width, height],
        "headline": HEADLINE, "headline_lines": [line for line, _, _, _ in HEADLINE_LINES],
        "headline_sizes_at_1080p": [size for _, _, size, _ in HEADLINE_LINES],
        "brand": "笺", "category": "翻译工具",
        "style": "pastel pink/lavender, clear anime character on right, raised exact headline, smaller real popup at bottom left",
        "icon_source": str(ICON.relative_to(ROOT)), "background_icon_opacity": .72,
        "background_blur_at_1080p": .5, "left_readability_veil": True,
        "popup_bounds_at_1080p": [142, 650, 742, 650+panel_height/SCALE],
        "right_foreground_free_from_x": 900,
        "type_assets": str(TYPE_ASSETS.relative_to(ROOT)),
        "type_bounds_at_4k": bounds,
        "output_files": [normal.name, high.name, jpeg.name, anime_cover.name],
    }
    (BUILD / "cover-layout.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Wrote 1920x1080 PNG/JPEG cover and 3840x2160 PNG master", flush=True)
    print("PASS: title and single product popup remain within cover safe areas", flush=True)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    create()
