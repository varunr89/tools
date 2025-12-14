#!/usr/bin/env python3
"""
Extract text from a directory of JPGs into a single Markdown file.

Primary target: macOS / Apple Silicon. Default OCR backend uses Apple's Vision framework
via PyObjC (fast, on-device, no external binaries).

Optionally, you can try an MLX-based OCR backend (mlx-ocr). Because MLX can abort the
process when Metal is unavailable, the MLX backend runs in a subprocess for safety.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Iterable, List, Optional, Sequence, Tuple


SUPPORTED_IMAGE_EXTS = {".jpg", ".jpeg", ".JPG", ".JPEG"}


@dataclass(frozen=True)
class OcrResult:
    filename: str
    text: str
    backend: str


def _iter_images(input_dir: Path) -> List[Path]:
    if not input_dir.exists():
        raise FileNotFoundError(f"Input directory not found: {input_dir}")
    if not input_dir.is_dir():
        raise NotADirectoryError(f"Input path is not a directory: {input_dir}")

    images = [p for p in sorted(input_dir.iterdir()) if p.suffix in SUPPORTED_IMAGE_EXTS and p.is_file()]
    return images


def _slice_images(images: Sequence[Path], start: int, limit: Optional[int]) -> List[Path]:
    if start < 0:
        raise ValueError("--start must be >= 0")
    if limit is not None and limit <= 0:
        raise ValueError("--limit must be >= 1")

    sliced = list(images[start:])
    if limit is not None:
        sliced = sliced[:limit]
    return sliced


def _write_markdown(results: Sequence[OcrResult], output_path: Path, input_dir: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)

    lines: List[str] = []
    lines.append("# Training Plan OCR")
    lines.append("")
    lines.append(f"- Source directory: `{input_dir}`")
    lines.append(f"- Files processed: {len(results)}")
    lines.append("")

    for r in results:
        lines.append(f"## {r.filename}")
        lines.append("")
        lines.append(f"_OCR backend: `{r.backend}`_")
        lines.append("")
        lines.append("```text")
        lines.append((r.text or "").rstrip())
        lines.append("```")
        lines.append("")

    output_path.write_text("\n".join(lines), encoding="utf-8")


def _vision_ocr_one(image_path: Path, languages: Optional[List[str]], fast: bool) -> str:
    try:
        from Foundation import NSURL  # type: ignore
        import Vision  # type: ignore
    except Exception as e:  # pragma: no cover
        raise RuntimeError(
            "Vision OCR backend requires macOS + PyObjC. Install with: "
            "pip install pyobjc-core pyobjc-framework-Vision"
        ) from e

    nsurl = NSURL.fileURLWithPath_(str(image_path))

    # Completion handler is required by the API but we access results synchronously after perform.
    def _completion_handler(_request, _error):
        return

    request = Vision.VNRecognizeTextRequest.alloc().initWithCompletionHandler_(_completion_handler)
    request.setUsesLanguageCorrection_(True)

    # recognitionLevel: Accurate vs Fast
    if fast:
        request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelFast)
    else:
        request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)

    if languages:
        request.setRecognitionLanguages_(languages)

    handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(nsurl, None)
    ok, err = handler.performRequests_error_([request], None)
    if not ok:
        raise RuntimeError(f"Vision OCR failed for {image_path}: {err}")

    observations = list(request.results() or [])

    def _sort_key(obs) -> Tuple[float, float]:
        # boundingBox origin is bottom-left, normalized.
        bb = obs.boundingBox()
        return (-float(bb.origin.y), float(bb.origin.x))

    observations.sort(key=_sort_key)

    lines: List[str] = []
    for obs in observations:
        candidates = obs.topCandidates_(1)
        if not candidates:
            continue
        lines.append(str(candidates[0].string()))

    return "\n".join(lines).strip()


def _maybe_preprocess_for_tesseract(image_path: Path, preprocess: bool, scale: float) -> Path:
    if not preprocess:
        return image_path

    from PIL import Image as PILImage, ImageEnhance, ImageOps  # type: ignore

    img = PILImage.open(str(image_path)).convert("L")
    img = ImageOps.autocontrast(img)
    if scale and scale != 1.0:
        w, h = img.size
        img = img.resize((int(w * scale), int(h * scale)))

    # Mild contrast boost tends to help with screenshots.
    img = ImageEnhance.Contrast(img).enhance(1.5)

    tmp_dir = Path(".ocr_tmp")
    tmp_dir.mkdir(parents=True, exist_ok=True)
    out_path = tmp_dir / f"{image_path.stem}__pre.png"
    img.save(str(out_path), format="PNG")
    return out_path


def _tesseract_ocr_one(
    image_path: Path,
    lang: str,
    psm: int,
    oem: int,
    preprocess: bool,
    preprocess_scale: float,
) -> str:
    pre_path = _maybe_preprocess_for_tesseract(image_path, preprocess=preprocess, scale=preprocess_scale)

    cmd = [
        "tesseract",
        str(pre_path),
        "stdout",
        "-l",
        lang,
        "--psm",
        str(psm),
        "--oem",
        str(oem),
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"tesseract failed (exit {proc.returncode})")
    return (proc.stdout or "").strip()


def _run_mlx_worker(python_exe: str, image_path: Path, det_lang: str, rec_lang: str) -> str:
    proc = subprocess.run(
        [
            python_exe,
            __file__,
            "--mlx-worker",
            "--image",
            str(image_path),
            "--det-lang",
            det_lang,
            "--rec-lang",
            rec_lang,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        # MLX failures can abort the process (e.g. Metal unavailable). Surface a clearer hint.
        if "NSRangeException" in stderr and "metal::Device" in stderr:
            raise RuntimeError(
                "MLX crashed while initializing Metal (GPU) in the worker process. "
                "This usually means no Metal device is visible in that process (e.g. sandboxed/CI session). "
                "Try running from your normal Terminal, or use `--backend tesseract`."
            )
        raise RuntimeError(stderr or f"MLX OCR worker failed (exit {proc.returncode})")

    try:
        payload = json.loads(proc.stdout)
        return str(payload.get("text", "")).strip()
    except Exception as e:
        raise RuntimeError(f"Failed to parse MLX OCR worker output for {image_path}") from e


def _mlx_worker_main(image: Path, det_lang: str, rec_lang: str) -> int:
    # NOTE: Import inside worker mode; MLX can abort the process if Metal is unavailable.
    from PIL import Image as PILImage  # type: ignore

    from mlx_ocr import MLXOCR  # type: ignore

    ocr = MLXOCR(det_lang=det_lang, rec_lang=rec_lang)
    pil = PILImage.open(str(image)).convert("RGB")
    text_boxes = ocr(pil)

    def _sort_key(tb) -> Tuple[int, int]:
        # Box is a contour; approximate position by bounding rect.
        import cv2  # type: ignore

        x, y, w, h = cv2.boundingRect(tb["box"])
        return (y, x)

    text_boxes = sorted(text_boxes, key=_sort_key)
    text = "\n".join([str(tb.get("text", "")).strip() for tb in text_boxes]).strip()
    sys.stdout.write(json.dumps({"text": text}))
    return 0


def _process_single_image(
    path: Path,
    backend: str,
    languages: Optional[List[str]],
    fast: bool,
    det_lang: str,
    rec_lang: str,
    python_exe: str,
    tesseract_lang: str,
    tesseract_psm: int,
    tesseract_oem: int,
    preprocess: bool,
    preprocess_scale: float,
) -> OcrResult:
    """Process a single image and return the OCR result."""
    text = ""
    used_backend = backend

    if backend == "vision":
        text = _vision_ocr_one(path, languages=languages, fast=fast)
    elif backend == "tesseract":
        text = _tesseract_ocr_one(
            path,
            lang=tesseract_lang,
            psm=tesseract_psm,
            oem=tesseract_oem,
            preprocess=preprocess,
            preprocess_scale=preprocess_scale,
        )
    elif backend == "mlx_ocr":
        if sys.version_info < (3, 10) and (python_exe == sys.executable):
            raise RuntimeError(
                "mlx-ocr requires Python 3.10+. You're running Python "
                f"{sys.version_info.major}.{sys.version_info.minor}. "
                "Create a Python 3.11 venv and pass `--mlx-worker-python ./venv311/bin/python`."
            )
        text = _run_mlx_worker(python_exe, path, det_lang=det_lang, rec_lang=rec_lang)
    elif backend == "auto":
        try:
            text = _vision_ocr_one(path, languages=languages, fast=fast)
            used_backend = "vision"
        except Exception:
            text = _tesseract_ocr_one(
                path,
                lang=tesseract_lang,
                psm=tesseract_psm,
                oem=tesseract_oem,
                preprocess=preprocess,
                preprocess_scale=preprocess_scale,
            )
            used_backend = "tesseract"
    else:
        raise ValueError(f"Unknown backend: {backend}")

    return OcrResult(filename=path.name, text=text, backend=used_backend)


def extract_to_markdown(
    input_dir: Path,
    output_path: Path,
    backend: str,
    start: int,
    limit: Optional[int],
    languages: Optional[List[str]],
    fast: bool,
    det_lang: str,
    rec_lang: str,
    mlx_worker_python: Optional[str],
    tesseract_lang: str,
    tesseract_psm: int,
    tesseract_oem: int,
    preprocess: bool,
    preprocess_scale: float,
    workers: int,
) -> None:
    images = _iter_images(input_dir)
    images = _slice_images(images, start=start, limit=limit)
    if not images:
        raise RuntimeError(f"No JPG/JPEG files found in {input_dir}")

    python_exe = mlx_worker_python or sys.executable
    total = len(images)

    # Progress tracking with thread-safe counter
    completed = [0]
    print_lock = Lock()

    def process_with_progress(path: Path) -> OcrResult:
        result = _process_single_image(
            path=path,
            backend=backend,
            languages=languages,
            fast=fast,
            det_lang=det_lang,
            rec_lang=rec_lang,
            python_exe=python_exe,
            tesseract_lang=tesseract_lang,
            tesseract_psm=tesseract_psm,
            tesseract_oem=tesseract_oem,
            preprocess=preprocess,
            preprocess_scale=preprocess_scale,
        )
        with print_lock:
            completed[0] += 1
            print(f"[{completed[0]}/{total}] OCR: {path.name}", file=sys.stderr)
        return result

    # Use thread pool for parallel GPU utilization
    # Vision framework releases GIL during GPU work, so threads work well
    results_map: dict[str, OcrResult] = {}

    if workers == 1:
        # Sequential mode for debugging
        for path in images:
            result = process_with_progress(path)
            results_map[path.name] = result
    else:
        print(f"Processing {total} images with {workers} workers...", file=sys.stderr)
        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_to_path = {executor.submit(process_with_progress, path): path for path in images}
            for future in as_completed(future_to_path):
                path = future_to_path[future]
                try:
                    result = future.result()
                    results_map[path.name] = result
                except Exception as e:
                    print(f"ERROR processing {path.name}: {e}", file=sys.stderr)
                    results_map[path.name] = OcrResult(filename=path.name, text=f"[ERROR: {e}]", backend="error")

    # Restore original order
    results = [results_map[p.name] for p in images]
    _write_markdown(results, output_path=output_path, input_dir=input_dir)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Extract text from JPGs into a Markdown file.")
    parser.add_argument(
        "--input",
        default="ezgif-1c2d7a728cf1b200-jpg",
        help="Input directory containing .jpg/.jpeg files",
    )
    parser.add_argument(
        "--output",
        default="training_plan_ocr.md",
        help="Output Markdown file path",
    )
    parser.add_argument(
        "--backend",
        default="auto",
        choices=["auto", "vision", "tesseract", "mlx_ocr"],
        help="OCR backend to use (default: auto = vision then tesseract)",
    )
    parser.add_argument("--start", type=int, default=0, help="Start index (0-based) within sorted file list")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of files processed")
    parser.add_argument(
        "--languages",
        default="en-US",
        help="Comma-separated recognition languages for Vision OCR (default: en-US). Use '' to unset.",
    )
    parser.add_argument(
        "--fast",
        action="store_true",
        help="Use faster (less accurate) text recognition level for Vision OCR",
    )
    parser.add_argument("--det-lang", default="eng", help="mlx-ocr detection language (default: eng)")
    parser.add_argument("--rec-lang", default="lat", help="mlx-ocr recognition language (default: lat)")
    parser.add_argument(
        "--mlx-worker-python",
        default=None,
        help="Python executable to run mlx-ocr worker (use a Python 3.11 venv, e.g. ./venv311/bin/python)",
    )
    parser.add_argument("--tesseract-lang", default="eng", help="tesseract language (default: eng)")
    parser.add_argument("--tesseract-psm", type=int, default=6, help="tesseract page segmentation mode (default: 6)")
    parser.add_argument("--tesseract-oem", type=int, default=1, help="tesseract OCR engine mode (default: 1)")
    parser.add_argument(
        "--preprocess",
        action="store_true",
        help="Preprocess images (grayscale/autocontrast/upscale) before running tesseract",
    )
    parser.add_argument(
        "--preprocess-scale",
        type=float,
        default=2.0,
        help="Upscale factor for --preprocess (default: 2.0)",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=os.cpu_count() or 8,
        help="Number of parallel workers (default: number of CPU cores). Use 1 for sequential processing.",
    )

    # Internal worker mode for mlx_ocr (isolates potential MLX aborts).
    parser.add_argument("--mlx-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--image", default=None, help=argparse.SUPPRESS)

    args = parser.parse_args(argv)

    if args.mlx_worker:
        if not args.image:
            raise SystemExit("--mlx-worker requires --image")
        return _mlx_worker_main(Path(args.image), det_lang=args.det_lang, rec_lang=args.rec_lang)

    langs = None
    if args.languages is not None and args.languages != "":
        langs = [s.strip() for s in args.languages.split(",") if s.strip()]
        if not langs:
            langs = None

    extract_to_markdown(
        input_dir=Path(args.input),
        output_path=Path(args.output),
        backend=args.backend,
        start=args.start,
        limit=args.limit,
        languages=langs,
        fast=bool(args.fast),
        det_lang=args.det_lang,
        rec_lang=args.rec_lang,
        mlx_worker_python=args.mlx_worker_python,
        tesseract_lang=args.tesseract_lang,
        tesseract_psm=args.tesseract_psm,
        tesseract_oem=args.tesseract_oem,
        preprocess=bool(args.preprocess),
        preprocess_scale=float(args.preprocess_scale),
        workers=args.workers,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
