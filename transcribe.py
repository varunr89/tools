#!/usr/bin/env python3
"""
Fast MP3 transcription using MLX Whisper on Apple Silicon.
Optimized for M3 Pro GPU acceleration.
"""

import glob
import os
import time
from pathlib import Path

import mlx_whisper


def transcribe_files(
    input_dir: str = ".",
    output_dir: str = "transcripts",
    model: str = "mlx-community/whisper-large-v3-turbo",
):
    """
    Transcribe all MP3 files in the input directory.

    Args:
        input_dir: Directory containing MP3 files
        output_dir: Directory to save transcripts
        model: MLX Whisper model to use (turbo is fastest with good quality)
    """
    # Find all MP3 files
    mp3_files = sorted(glob.glob(os.path.join(input_dir, "*.mp3")))

    if not mp3_files:
        print("No MP3 files found in the current directory.")
        return

    print(f"Found {len(mp3_files)} MP3 files to transcribe")
    print(f"Using model: {model}")
    print("-" * 60)

    # Create output directory
    os.makedirs(output_dir, exist_ok=True)

    total_start = time.time()

    for i, mp3_path in enumerate(mp3_files, 1):
        filename = os.path.basename(mp3_path)
        stem = Path(mp3_path).stem
        output_path = os.path.join(output_dir, f"{stem}.txt")

        print(f"\n[{i}/{len(mp3_files)}] Transcribing: {filename}")
        start = time.time()

        try:
            # Transcribe using MLX Whisper
            result = mlx_whisper.transcribe(
                mp3_path,
                path_or_hf_repo=model,
                verbose=False,
            )

            # Save transcript
            with open(output_path, "w", encoding="utf-8") as f:
                f.write(result["text"].strip())

            elapsed = time.time() - start
            print(f"    Done in {elapsed:.1f}s -> {output_path}")

        except Exception as e:
            print(f"    ERROR: {e}")

    total_elapsed = time.time() - total_start
    print("\n" + "=" * 60)
    print(f"Completed {len(mp3_files)} files in {total_elapsed:.1f}s")
    print(f"Average: {total_elapsed / len(mp3_files):.1f}s per file")
    print(f"Transcripts saved to: {output_dir}/")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Transcribe MP3 files using MLX Whisper")
    parser.add_argument(
        "--model",
        default="mlx-community/whisper-large-v3-turbo",
        help="Model to use (default: whisper-large-v3-turbo for speed+quality)",
    )
    parser.add_argument(
        "--output",
        default="transcripts",
        help="Output directory for transcripts (default: transcripts)",
    )
    parser.add_argument(
        "--input",
        default=".",
        help="Input directory containing MP3 files (default: current directory)",
    )

    args = parser.parse_args()
    transcribe_files(args.input, args.output, args.model)
