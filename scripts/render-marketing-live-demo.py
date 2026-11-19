"""Create the short 30fps Jian film using actual continuous MP4 subclips.

The screen demonstrations are passed to FFmpeg as video inputs. Python draws
only the backdrop, typography and device edging; it never substitutes extracted
stills for the demonstrations. Speech services and external networks are unused.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
VIDEO = ROOT / "output" / "video"
BUILD = VIDEO / ".jian_build" / "live-30fps"
CLIPS = VIDEO / "演示子视频-30fps"
MOVIE = VIDEO / "笺-真实演示-26秒-30fps.mp4"
SRT = VIDEO / "笺-真实演示-26秒-30fps.srt"
W, H, FPS, SECONDS = 1920, 1080, 30, 26
TRANSITION = .20
HANDLE_FRAMES = round(TRANSITION * FPS)

# Reuse only the earlier film's font, glyph layout and background utilities.
# Its Footage class and its still/hold rendering paths are never invoked.
spec = importlib.util.spec_from_file_location(
    "jian_marketing_typography", ROOT / "scripts" / "render-marketing-video.py"
)
if spec is None or spec.loader is None:
    raise RuntimeError("Typography helper module is unavailable")
art = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = art
spec.loader.exec_module(art)


@dataclass(frozen=True)
class Cue:
    start: float
    end: float
    text: str


CUES = (
    Cue(0, 1.6, "不懂的一句。"),
    Cue(1.6, 5.8, "放入原文，译文展开。"),
    Cue(5.8, 9.2, "原文与译文，同屏对照。"),
    Cue(9.2, 13.5, "选中，译文就在眼前。"),
    Cue(13.5, 19.9, "拿起手机，也能轻松读懂。"),
    Cue(19.9, 24, "看懂之后，继续读下去。"),
    Cue(24, 26, "从选中，到读懂。"),
)


@dataclass(frozen=True)
class Subclip:
    key: str
    filename: str
    source: str
    source_in: float
    timeline_in: float
    timeline_out: float
    crop: tuple[int, int, int, int]
    screen_size: tuple[int, int]
    location: tuple[int, int]

    @property
    def duration(self) -> float:
        return round(self.timeline_out - self.timeline_in, 3)

    @property
    def file_frames(self) -> int:
        return round(self.duration * FPS) + HANDLE_FRAMES

    @property
    def path(self) -> Path:
        return CLIPS / self.filename


SUBCLIPS = (
    Subclip(
        "desktop", "01-桌面文本翻译-连续.mp4", "屏幕录制 2026-11-18 215704.mp4",
        16.1, 1.6, 9.2, (16, 76, 1188, 782), (1000, 658), (771, 212),
    ),
    Subclip(
        "popup", "02-划词浮窗-连续.mp4", "屏幕录制 2026-11-18 220151.mp4",
        0.0, 9.2, 13.5, (16, 114, 855, 444), (1000, 600), (771, 242),
    ),
    Subclip(
        "phone-translation", "03-手机译文生成-连续.mp4",
        "Screenrecorder-2026-11-18-16-22-58-255.mp4",
        8.0, 13.5, 19.9, (12, 100, 1196, 2444), (430, 878), (1109, 89),
    ),
    Subclip(
        "phone-reading", "04-手机原文对照-连续.mp4",
        "Screenrecorder-2026-11-18-16-22-58-255.mp4",
        15.2, 19.9, 24.0, (12, 100, 1196, 2444), (430, 878), (1109, 89),
    ),
)


def probe(path: Path, *, decode: bool = False) -> dict:
    command = ["ffprobe", "-v", "error"]
    if decode:
        command.append("-count_frames")
    command += ["-show_entries", "format=duration:stream=width,height,avg_frame_rate,nb_frames,nb_read_frames,codec_type", "-of", "json", str(path)]
    result = subprocess.run(command, check=True, capture_output=True, encoding="utf-8")
    return json.loads(result.stdout)


def prepare_subclips() -> None:
    CLIPS.mkdir(parents=True, exist_ok=True)
    source_metadata: dict[str, dict] = {}
    manifest = []
    for clip in SUBCLIPS:
        source_path = VIDEO / clip.source
        if clip.source not in source_metadata:
            source_metadata[clip.source] = probe(source_path)
        source_duration = float(source_metadata[clip.source]["format"]["duration"])
        source_out = clip.source_in + clip.file_frames / FPS
        if source_out > source_duration + .001:
            raise ValueError(f"Subclip exceeds its source recording: {clip.key}")
        print(f"Cutting continuous MP4: {clip.key}, source {clip.source_in:.2f}–{source_out:.2f}s", flush=True)
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-ss", f"{clip.source_in:.6f}", "-i", str(source_path),
             "-an", "-vf", "fps=30,setpts=PTS-STARTPTS", "-frames:v", str(clip.file_frames),
             "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-threads", "4",
             "-pix_fmt", "yuv420p", "-r", str(FPS), "-fps_mode", "cfr", "-movflags", "+faststart", str(clip.path)],
            check=True,
        )
        result = probe(clip.path)
        stream = next(s for s in result["streams"] if s["codec_type"] == "video")
        if int(stream.get("nb_frames", 0)) != clip.file_frames or stream["avg_frame_rate"] != "30/1":
            raise RuntimeError(f"Subclip must have its full expected continuous duration: {clip.key}")
        manifest.append({
            **asdict(clip), "crop": list(clip.crop), "screen_size": list(clip.screen_size),
            "source_visible_out": round(clip.source_in + clip.duration, 3),
            "source_file_out_with_transition_handle": round(source_out, 3),
            "frames_with_transition_handle": clip.file_frames,
            "normal_speed": 1.0, "fps": FPS, "transition_handle_seconds": TRANSITION,
        })
    (CLIPS / "剪辑来源与时码.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def cue_at(t: float) -> tuple[int, float]:
    for index, cue in enumerate(CUES):
        if cue.start <= t < cue.end:
            return index, t-cue.start
    raise ValueError(f"Timestamp outside the film: {t}")


def position(clip: Subclip, t: float) -> tuple[int, int]:
    amount = art.ease((t-clip.timeline_in) / .48)
    x = clip.location[0] + round(52 * (1-amount))
    return x, clip.location[1]


def clip_opacity(clip: Subclip, t: float) -> float:
    return art.clamp((t-clip.timeline_in) / TRANSITION) * (
        1-art.clamp((t-clip.timeline_out) / TRANSITION)
    )


def device_edge(canvas: Image.Image, clip: Subclip, t: float) -> None:
    x, y = position(clip, t)
    width, height = clip.screen_size
    alpha = clip_opacity(clip, t)
    layer = Image.new("RGBA", (width+110, height+120))
    shadow = Image.new("RGBA", layer.size)
    ImageDraw.Draw(shadow).rounded_rectangle((41, 46, width+67, height+76), radius=17,
                                             fill=(17, 23, 30, round(32*alpha)))
    layer.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(19)))
    draw = ImageDraw.Draw(layer)
    draw.rounded_rectangle((49, 40, width+69, height+60), 14,
                           fill=(181, 187, 195, round(255*alpha)))
    draw.rounded_rectangle((51, 42, width+67, height+58), 12,
                           fill=(249, 249, 248, round(255*alpha)))
    draw.rounded_rectangle((52, 43, width+66, height+57), 11,
                           outline=(255, 255, 255, round(255*alpha)), width=1)
    canvas.paste(layer, (x-59, y-50), layer)


def graphics(t: float, join: bool = True) -> Image.Image:
    scene, u = cue_at(t)
    canvas = art.background().copy()
    ease = art.ease
    clamp = art.clamp
    put = art.put_type
    ink, muted = art.INK, art.MUTED
    p = ease(u/.52)
    if scene == 0:
        put(canvas, "不懂的", (335, 313), 156, progress=clamp((u-.05)/.45), stagger=True)
        put(canvas, "一句。", (342, 532), 108, color=muted, progress=clamp((u-.40)/.42), stagger=True)
    elif scene == 1:
        x = 152 + round(22*(1-p))
        put(canvas, "放入原文，", (x, 318), 44, color=muted, opacity=p)
        put(canvas, "译文", (x-5, 414), 144, scale=art.lerp(.94, 1, p),
            progress=clamp((u-.12)/.58), stagger=True)
        put(canvas, "展开。", (x-5, 588), 116, progress=clamp((u-.4)/.50), stagger=True)
    elif scene == 2:
        # The same desktop MP4 continues without resetting at this type change.
        put(canvas, "原文与译文，", (154, 316), 44, color=muted, opacity=p)
        put(canvas, "同屏", (146, 420), 132, progress=clamp(u/.60), stagger=True)
        put(canvas, "对照。", (146, 584), 116, progress=clamp((u-.28)/.52), stagger=True)
    elif scene == 3:
        y = art.lerp(345, 320, p)
        mask_bottom = round(y + art.lerp(63, 170, ease((u-.20)/.50)))
        put(canvas, "选中，", (148, y), 132, clip=(100, 250, 732, mask_bottom), opacity=p)
        put(canvas, "译文就在", (158, 509), 52, color=muted, progress=clamp((u-.36)/.50), stagger=True)
        put(canvas, "眼前。", (150, 601), 100, progress=clamp((u-.60)/.50), stagger=True)
    elif scene == 4:
        # Half occlusion is confined to the beginning, then text becomes complete.
        x = art.lerp(610, 151, ease(u/.72))
        put(canvas, "拿起手机，", (155, 300), 44, color=muted, opacity=p)
        put(canvas, "也能", (x, 409), 116, scale=art.lerp(.95,1,p), progress=clamp((u-.12)/.54), stagger=True)
        put(canvas, "轻松读懂。", (x, 560), 100, progress=clamp((u-.34)/.58), stagger=True)
    elif scene == 5:
        x = art.lerp(236, 153, p)
        put(canvas, "看懂之后，", (155, 313), 44, color=muted, opacity=p)
        put(canvas, "继续", (x, 416), 132, progress=clamp(u/.55), stagger=True)
        put(canvas, "读下去。", (x, 580), 116, progress=clamp((u-.24)/.52), stagger=True)
    else:
        canvas = Image.new("RGB", (W,H), (10,11,13))
        title_width = art.text_width("笺", 126)
        put(canvas, "笺", ((W-title_width)/2, art.lerp(358,338,p)), 126,
            color=art.WHITE, opacity=p)
        label = "从选中，到读懂。"
        label_width = art.text_width(label, 46, 3)
        put(canvas, label, ((W-label_width)/2,550),46, color=(206,206,204),tracking=3,
            progress=clamp((u-.30)/.68),stagger=True)

    for clip in SUBCLIPS:
        if clip.timeline_in <= t < clip.timeline_out + TRANSITION:
            device_edge(canvas,clip,t)
    if join and scene and u < .24:
        # Only the drawn type/backdrop is used in this mask transition. Actual
        # screen footage remains live in the independent FFmpeg video inputs.
        previous=graphics(CUES[scene].start-1/FPS,join=False)
        edge=art.ease(u/.24)*(W+40)-20
        mask=np.clip((edge-np.arange(W,dtype=np.float32))/20+1,0,1)[None,:,None]
        mixed=np.asarray(previous,dtype=np.float32)*(1-mask)+np.asarray(canvas,dtype=np.float32)*mask
        canvas=Image.fromarray(np.clip(mixed,0,255).astype(np.uint8))
    return canvas


def native_graph() -> str:
    parts = ["[0:v]setpts=PTS-STARTPTS[base]"]
    previous = "base"
    for index, clip in enumerate(SUBCLIPS, 1):
        x,y,width,height = clip.crop
        sw,sh = clip.screen_size
        # Both the outgoing and incoming images stay live during the overlap.
        # repeatlast=0 explicitly disables FFmpeg's implicit last-frame hold.
        parts.append(
            f"[{index}:v]crop={width}:{height}:{x}:{y},"
            f"scale={sw}:{sh}:force_original_aspect_ratio=decrease:flags=lanczos,"
            f"pad={sw}:{sh}:(ow-iw)/2:(oh-ih)/2:color=0xF9F9F9,"
            "setsar=1,format=yuva420p,"
            f"fade=t=in:st=0:d={TRANSITION:.3f}:alpha=1,"
            f"fade=t=out:st={clip.duration:.3f}:d={TRANSITION:.3f}:alpha=1,"
            f"setpts=PTS-STARTPTS+{clip.timeline_in:.6f}/TB[clip{index}]"
        )
        p = f"clip((t-{clip.timeline_in:.6f})/0.48,0,1)"
        e = f"({p})*({p})*(3-2*({p}))"
        px = f"{clip.location[0]}+52*(1-({e}))"
        current = f"overlay{index}"
        parts.append(
            f"[{previous}][clip{index}]overlay=x='{px}':y={clip.location[1]}:"
            "eof_action=pass:repeatlast=0:shortest=0:"
            f"enable='gte(t,{clip.timeline_in:.6f})*lt(t,{clip.timeline_out+TRANSITION:.6f})'"
            f"[{current}]"
        )
        previous=current
    parts.append(f"[{previous}]format=yuv420p[out]")
    return ";\n".join(parts)


def render_graphics() -> Path:
    target=BUILD/"typography-and-background-30fps.mp4"
    with (BUILD/"graphics-encoder.log").open("w",encoding="utf-8") as log:
        process=subprocess.Popen(
            ["ffmpeg","-y","-v","warning","-f","rawvideo","-pixel_format","rgb24",
             "-video_size",f"{W}x{H}","-framerate",str(FPS),"-i","pipe:0","-an",
             "-c:v","libx264","-preset","fast","-crf","16","-threads","4",
             "-pix_fmt","yuv420p","-movflags","+faststart",str(target)],stdin=subprocess.PIPE,stderr=log)
        assert process.stdin is not None
        try:
            for index in range(FPS*SECONDS):
                process.stdin.write(np.asarray(graphics(index/FPS)).tobytes())
                if index%(FPS*5)==0:
                    print(f"Rendering typography {index/FPS:.0f}/{SECONDS}s",flush=True)
            process.stdin.close()
        except BaseException:
            process.stdin.close()
            process.terminate()
            process.wait()
            raise
        if process.wait()!=0:
            raise RuntimeError("Typography video encoding failed")
    return target


def save_subtitles() -> None:
    def stamp(t:float)->str:
        millis=round(t*1000)
        minutes,millis=divmod(millis,60_000)
        seconds,millis=divmod(millis,1000)
        return f"00:{minutes:02}:{seconds:02},{millis:03}"
    text="\n\n".join(f"{i}\n{stamp(c.start)} --> {stamp(c.end)}\n{c.text}" for i,c in enumerate(CUES,1))
    SRT.write_text(text+"\n",encoding="utf-8-sig")


def render() -> None:
    prepare_subclips()
    graphic_video=render_graphics()
    graph=native_graph()
    graph_path=BUILD/"native-video-composite.ffgraph"
    graph_path.write_text(graph,encoding="utf-8")
    inputs=["ffmpeg","-y","-v","warning","-filter_complex_threads","1","-i",str(graphic_video)]
    for clip in SUBCLIPS:
        inputs += ["-i",str(clip.path)]
    temp=BUILD/"continuous-demo.rendering.mp4"
    command=inputs+[
        "-filter_complex_script",str(graph_path),"-map","[out]","-an","-frames:v",str(FPS*SECONDS),
        "-r",str(FPS),"-fps_mode","cfr","-c:v","libx264","-preset","fast","-crf","17",
        "-threads","4","-pix_fmt","yuv420p","-movflags","+faststart",str(temp)]
    print("Compositing four continuous video inputs in FFmpeg",flush=True)
    with (BUILD/"native-composite.log").open("w",encoding="utf-8") as log:
        subprocess.run(command,check=True,stderr=log)
    result=probe(temp)
    video=next(s for s in result["streams"] if s["codec_type"]=="video")
    if int(video["nb_frames"])!=FPS*SECONDS or video["avg_frame_rate"]!="30/1":
        raise RuntimeError("Continuous film duration or framerate is incorrect")
    temp.replace(MOVIE)
    save_subtitles()
    (BUILD/"render-metadata.json").write_text(json.dumps({
        "duration":SECONDS,"fps":FPS,"frames":FPS*SECONDS,"audio":False,
        "live_demonstration_seconds":22.4,"intro_seconds":1.6,"outro_seconds":2,
        "demonstration_inputs":"four actual continuous MP4 subclips", "freeze_or_loop":False,
        "cues":[asdict(c) for c in CUES]},ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"Rendered {MOVIE.name}: {SECONDS}s at {FPS}fps",flush=True)


def previews() -> None:
    """Extracted frames are QA-only; the production graph reads MP4 inputs."""
    times=(.8,2.3,4.4,6.7,9.6,10.5,12.4,14.2,16.5,18.9,20.7,22.8,24.8,25.5)
    capture=cv2.VideoCapture(str(MOVIE))
    if not capture.isOpened():
        raise RuntimeError("Render the continuous film before inspecting it")
    sheet=Image.new("RGB",(1920,1080),(236,236,236))
    for i,t in enumerate(times):
        capture.set(cv2.CAP_PROP_POS_MSEC,t*1000)
        ok,frame=capture.read()
        if not ok:
            raise RuntimeError(f"Cannot inspect encoded film near {t}s")
        image=Image.fromarray(cv2.cvtColor(frame,cv2.COLOR_BGR2RGB))
        image.save(BUILD/f"encoded-{t:05.2f}.jpg",quality=93)
        sheet.paste(image.resize((480,270),Image.Resampling.LANCZOS),((i%4)*480,(i//4)*270))
    capture.release()
    sheet.save(BUILD/"continuous-film-contact-sheet.jpg",quality=94)
    print("Saved encoded QA images; these are not production inputs",flush=True)


def validate()->None:
    assert CUES[0].start==0 and CUES[-1].end==SECONDS
    assert all(CUES[i].end==CUES[i+1].start for i in range(len(CUES)-1))
    assert FPS*SECONDS==780
    assert round(sum(c.duration for c in SUBCLIPS),3)==22.4
    assert SUBCLIPS[0].timeline_in==1.6 and SUBCLIPS[-1].timeline_out==24
    assert all(SUBCLIPS[i].timeline_out==SUBCLIPS[i+1].timeline_in for i in range(len(SUBCLIPS)-1))
    graph=native_graph()
    assert graph.count("repeatlast=0")==4
    assert not any(token in graph for token in ("tpad","loop=","zoompan","image2"))
    assert art.text_width("轻松读懂。",100)<780
    print("PASS: 26s, 30fps, 780 frames; 22.4s of continuous clips, no hold/loop filters",flush=True)


def main()->None:
    if hasattr(sys.stdout,"reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--render",action="store_true")
    parser.add_argument("--preview",action="store_true")
    args=parser.parse_args()
    BUILD.mkdir(parents=True,exist_ok=True)
    validate()
    if args.render:
        render()
    if args.preview:
        previews()


if __name__=="__main__":
    main()
