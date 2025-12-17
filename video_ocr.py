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
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import Vision
from Cocoa import NSURL


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


def process_video(video_path: str, output_path: str, fps: float = 3.0, workers: int = 8):
    """Extract text from video and save to JSONL."""
    print(f"Processing: {video_path}")
    print(f"FPS: {fps}, Workers: {workers}")

    with tempfile.TemporaryDirectory() as temp_dir:
        # Extract frames
        print("Extracting frames...")
        frames = extract_frames(video_path, temp_dir, fps)
        print(f"Extracted {len(frames)} frames")

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

        print(f"Done! Output: {output_path}")
        print(f"Total frames: {len(results)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract text from video using Apple Vision OCR")
    parser.add_argument("video", help="Input video file")
    parser.add_argument("-o", "--output", default="ocr_output.jsonl", help="Output JSONL file")
    parser.add_argument("--fps", type=float, default=3.0, help="Frames per second to extract (default: 3)")
    parser.add_argument("--workers", type=int, default=8, help="Parallel workers (default: 8)")

    args = parser.parse_args()
    process_video(args.video, args.output, args.fps, args.workers)
