"""Add a quiet continuous music excerpt without re-encoding Jian's video.

The music path is supplied explicitly by the caller. Only the supplied audio
stream is used; embedded artwork, track comments and other tags are not copied.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VIDEO = ROOT / "output" / "video"
BUILD = VIDEO / ".jian_build" / "bgm-mix"
SOURCE = VIDEO / "笺-真实演示-26秒-30fps.mp4"
OUTPUT = VIDEO / "笺-真实演示-26秒-30fps-BGM.mp4"
SECONDS = 26.0


def probe(path: Path) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,nb_frames,channels,sample_rate",
         "-of", "json", str(path)],
        check=True, capture_output=True, encoding="utf-8",
    )
    return json.loads(result.stdout)


def video_packet_hash(path: Path) -> str:
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:v:0",
         "-c:v", "copy", "-map_metadata", "-1", "-f", "streamhash",
         "-hash", "sha256", "pipe:1"],
        check=True, capture_output=True, encoding="utf-8",
    )
    return result.stdout.strip().split(",")[-1]


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--music", required=True, type=Path)
    parser.add_argument("--start", type=float, default=57.0)
    parser.add_argument("--gain-db", type=float, default=-9.0)
    parser.add_argument("--fade-in", type=float, default=.55)
    parser.add_argument("--fade-out-start", type=float, default=23.0)
    parser.add_argument("--fade-out-duration", type=float, default=2.8)
    args = parser.parse_args()
    music = args.music.resolve(strict=True)
    original = probe(SOURCE)
    track = probe(music)
    if args.start < 0 or args.start + SECONDS > float(track["format"]["duration"]):
        raise ValueError("Selected music excerpt is outside the supplied track")
    if not 0 < args.fade_in < SECONDS:
        raise ValueError("Fade-in must fit the short film")
    if not 0 <= args.fade_out_start < args.fade_out_start + args.fade_out_duration <= SECONDS:
        raise ValueError("Fade-out must fit the short film")
    if args.gain_db > 0:
        raise ValueError("This quiet BGM mix must not amplify the supplied music")
    source_video = next(s for s in original["streams"] if s["codec_type"] == "video")
    if source_video["avg_frame_rate"] != "30/1" or int(source_video["nb_frames"]) != 780:
        raise ValueError("Expected the completed 26-second, 30fps silent film")

    BUILD.mkdir(parents=True, exist_ok=True)
    temp = BUILD / "quiet-bgm.rendering.mp4"
    filters = (
        f"atrim=duration={SECONDS},asetpts=PTS-STARTPTS,"
        f"volume={args.gain_db:.6f}dB,"
        f"afade=t=in:st=0:d={args.fade_in:.6f}:curve=qsin,"
        f"afade=t=out:st={args.fade_out_start:.6f}:d={args.fade_out_duration:.6f}:curve=qsin"
    )
    command = [
        "ffmpeg", "-y", "-v", "error", "-i", str(SOURCE),
        "-ss", f"{args.start:.6f}", "-i", str(music),
        "-map", "0:v:0", "-map", "1:a:0", "-map_metadata", "-1", "-map_chapters", "-1",
        "-c:v", "copy", "-af", filters, "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-t", f"{SECONDS:.6f}", "-movflags", "+faststart", str(temp),
    ]
    subprocess.run(command, check=True)
    result = probe(temp)
    video = next(s for s in result["streams"] if s["codec_type"] == "video")
    audio = [s for s in result["streams"] if s["codec_type"] == "audio"]
    if len(result["streams"]) != 2 or len(audio) != 1:
        raise RuntimeError("Expected one original video stream and one music stream")
    for field in ("width", "height", "avg_frame_rate", "nb_frames"):
        if video[field] != source_video[field]:
            raise RuntimeError(f"Music mux changed the original video: {field}")
    if abs(float(result["format"]["duration"]) - SECONDS) > .04:
        raise RuntimeError("Music mux changed the film duration")
    packet_hash = video_packet_hash(SOURCE)
    if packet_hash != video_packet_hash(temp):
        raise RuntimeError("The original encoded video packets must remain unchanged")
    temp.replace(OUTPUT)
    if SOURCE.with_suffix(".srt").is_file():
        shutil.copyfile(SOURCE.with_suffix(".srt"), OUTPUT.with_suffix(".srt"))

    settings = {
        "music_filename": music.name,
        "selected_source_start_seconds": args.start,
        "selected_source_end_seconds": args.start + SECONDS,
        "duration": SECONDS, "fps": 30, "frames": 780,
        "music_gain_db": args.gain_db,
        "music_amplitude_ratio": round(10 ** (args.gain_db / 20), 4),
        "fade_in_seconds": args.fade_in,
        "fade_out_start_seconds": args.fade_out_start,
        "fade_out_end_seconds": args.fade_out_start + args.fade_out_duration,
        "fade_curve": "qsin",
        "final_silence_seconds": SECONDS - args.fade_out_start - args.fade_out_duration,
        "music_speed": 1.0, "looped_or_spliced": False,
        "video_codec_copy": True, "original_video_packet_sha256": packet_hash,
        "source_silent_film_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "output_filename": OUTPUT.name,
    }
    (BUILD / "mix-settings.json").write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {OUTPUT.name}", flush=True)
    print(f"Music excerpt {args.start:.2f}–{args.start + SECONDS:.2f}s; gain {args.gain_db:.2f}dB", flush=True)
    print("PASS: one music stream; 26s, 30fps, 780 frames; original video packets unchanged", flush=True)


if __name__ == "__main__":
    main()
