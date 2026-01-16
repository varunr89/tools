#!/usr/bin/env python3
"""
Extract text from video using Apple Vision OCR.
Optimized for Apple Silicon with GPU/Neural Engine acceleration.
"""

import argparse
import json
import os
import subprocess
import tempfile
import shutil
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Optional

import Vision
from Cocoa import NSURL


def hamming_distance(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def diff_ratio(a: int, b: int, hash_bits: int) -> float:
    if hash_bits <= 0:
        raise ValueError("hash_bits must be > 0")
    return hamming_distance(a, b) / hash_bits


def should_keep(prev_hash: Optional[int], curr_hash: int, max_diff_ratio: float, hash_bits: int) -> bool:
    if not (0.0 <= max_diff_ratio <= 1.0):
        raise ValueError("max_diff_ratio must be between 0 and 1")
    if prev_hash is None:
        return True
    return diff_ratio(prev_hash, curr_hash, hash_bits) > max_diff_ratio


def compute_ahash(image_path: str, hash_size: int) -> int:
    """Compute a simple perceptual average hash (aHash) for an image."""
    if hash_size <= 0:
        raise ValueError("hash_size must be > 0")

    try:
        from PIL import Image  # type: ignore
    except Exception as e:  # pragma: no cover
        raise RuntimeError(
            "Pillow is required for --dedupe. Install with: pip install pillow"
        ) from e

    resample = getattr(Image, "Resampling", Image).LANCZOS
    with Image.open(image_path) as img:
        img = img.convert("L").resize((hash_size, hash_size), resample)
        pixels = list(img.getdata())

    avg = sum(pixels) / len(pixels)
    bits = 0
    for p in pixels:
        bits = (bits << 1) | (1 if p > avg else 0)
    return bits


def dedupe_frames(
    frames: list[tuple[int, float, str]],
    max_diff_ratio: float,
    hash_size: int,
) -> list[tuple[int, float, str]]:
    """Keep frames whose visual hash differs beyond the threshold."""
    hash_bits = hash_size * hash_size
    kept: list[tuple[int, float, str]] = []
    prev_hash: Optional[int] = None

    for frame_num, time_sec, path in frames:
        curr_hash = compute_ahash(path, hash_size)
        if should_keep(prev_hash, curr_hash, max_diff_ratio, hash_bits):
            kept.append((frame_num, time_sec, path))
            prev_hash = curr_hash

    return kept


def _frame_filename(frame_num: int) -> str:
    return f"{frame_num:05d}.jpg"


def write_markdown(
    results: list[dict],
    output_path: str,
    video_path: str,
    include_images: bool = False,
    images_dir: Optional[str] = None,
):
    out_path = Path(output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    lines: list[str] = []
    lines.append("# Instructional OCR")
    lines.append("")
    lines.append(f"- Source video: `{video_path}`")
    lines.append(f"- Frames: {len(results)}")
    lines.append("")

    for result in results:
        frame_num = result["frame"]
        time_sec = result["time_sec"]
        lines.append(f"## Frame {frame_num:05d} @ {time_sec}s")
        lines.append("")
        if include_images and images_dir:
            img_path = os.path.join(images_dir, _frame_filename(frame_num))
            rel_path = os.path.relpath(img_path, start=out_path.parent)
            lines.append(f"![]({rel_path})")
            lines.append("")
        lines.append("```text")
        lines.append((result["text"] or "").rstrip())
        lines.append("```")
        lines.append("")

    out_path.write_text("\n".join(lines), encoding="utf-8")


def ocr_image(image_path: str) -> str:
    """Run Apple Vision OCR on an image file."""
    url = NSURL.fileURLWithPath_(image_path)

    # Create image request handler
    handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(url, None)

    # Create text recognition request
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    request.setUsesLanguageCorrection_(True)

    # Perform OCR
    success, error = handler.performRequests_error_([request], None)

    if not success or error:
        return ""

    # Extract text from results
    results = request.results()
    if not results:
        return ""

    lines = []
    for observation in results:
        text = observation.topCandidates_(1)[0].string()
        lines.append(text)

    return "\n".join(lines)


def extract_frames(video_path: str, output_dir: str, fps: float) -> list[tuple[int, float, str]]:
    """Extract frames from video at specified fps. Returns list of (frame_num, time_sec, path)."""
    os.makedirs(output_dir, exist_ok=True)

    # Extract frames using ffmpeg
    cmd = [
        "ffmpeg", "-i", video_path,
        "-vf", f"fps={fps}",
        "-q:v", "2",  # High quality JPEG
        os.path.join(output_dir, "%05d.jpg"),
        "-y", "-hide_banner", "-loglevel", "error"
    ]
    subprocess.run(cmd, check=True)

    # Collect frame info
    frames = []
    for f in sorted(Path(output_dir).glob("*.jpg")):
        frame_num = int(f.stem)
        time_sec = (frame_num - 1) / fps  # ffmpeg starts at 1
        frames.append((frame_num, time_sec, str(f)))

    return frames


def process_video(
    video_path: str,
    output_path: str,
    fps: float = 3.0,
    workers: int = 8,
    dedupe: bool = False,
    dedupe_threshold: float = 0.15,
    hash_size: int = 8,
    frames_out: Optional[str] = None,
    markdown_path: Optional[str] = None,
    markdown_images: bool = False,
):
    """Extract text from video and save to JSONL."""
    print(f"Processing: {video_path}")
    print(f"FPS: {fps}, Workers: {workers}")

    with tempfile.TemporaryDirectory() as temp_dir:
        # Extract frames
        print("Extracting frames...")
        frames = extract_frames(video_path, temp_dir, fps)
        print(f"Extracted {len(frames)} frames")

        if dedupe:
            print(f"Deduping frames (threshold={dedupe_threshold}, hash_size={hash_size})...")
            before = len(frames)
            frames = dedupe_frames(frames, dedupe_threshold, hash_size)
            print(f"Kept {len(frames)} / {before} frames after dedupe")

        if frames_out:
            out_dir = Path(frames_out)
            out_dir.mkdir(parents=True, exist_ok=True)
            for frame_num, _time_sec, path in frames:
                dest = out_dir / _frame_filename(frame_num)
                shutil.copy2(path, dest)

        # OCR in parallel
        print("Running OCR...")
        results = []

        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_to_frame = {
                executor.submit(ocr_image, path): (num, time_sec)
                for num, time_sec, path in frames
            }

            completed = 0
            for future in as_completed(future_to_frame):
                frame_num, time_sec = future_to_frame[future]
                text = future.result()
                results.append({
                    "frame": frame_num,
                    "time_sec": round(time_sec, 3),
                    "text": text
                })
                completed += 1
                if completed % 10 == 0:
                    print(f"  {completed}/{len(frames)} frames processed")

        # Sort by frame number and write output
        results.sort(key=lambda x: x["frame"])

        with open(output_path, "w", encoding="utf-8") as f:
            for result in results:
                f.write(json.dumps(result, ensure_ascii=False) + "\n")

        if markdown_path:
            write_markdown(
                results,
                markdown_path,
                video_path=video_path,
                include_images=markdown_images,
                images_dir=frames_out,
            )

        print(f"Done! Output: {output_path}")
        print(f"Total frames: {len(results)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract text from video using Apple Vision OCR")
    parser.add_argument("video", help="Input video file")
    parser.add_argument("-o", "--output", default="ocr_output.jsonl", help="Output JSONL file")
    parser.add_argument("--fps", type=float, default=3.0, help="Frames per second to extract (default: 3)")
    parser.add_argument("--workers", type=int, default=8, help="Parallel workers (default: 8)")
    parser.add_argument("--dedupe", action="store_true", help="Deduplicate visually similar frames")
    parser.add_argument(
        "--dedupe-threshold",
        type=float,
        default=0.15,
        help="Max visual difference ratio (0-1) to treat as similar (default: 0.15)",
    )
    parser.add_argument(
        "--hash-size",
        type=int,
        default=8,
        help="aHash size (hash_size x hash_size) (default: 8)",
    )
    parser.add_argument(
        "--frames-out",
        help="Optional directory to save kept frames (copied as JPGs)",
    )
    parser.add_argument(
        "--markdown",
        help="Optional Markdown output path for OCR results",
    )
    parser.add_argument(
        "--markdown-images",
        action="store_true",
        help="Embed images in Markdown (requires --frames-out)",
    )

    args = parser.parse_args()
    process_video(
        args.video,
        args.output,
        args.fps,
        args.workers,
        dedupe=args.dedupe,
        dedupe_threshold=args.dedupe_threshold,
        hash_size=args.hash_size,
        frames_out=args.frames_out,
        markdown_path=args.markdown,
        markdown_images=args.markdown_images,
    )
