#!/usr/bin/env python3
"""
Extract text from PDF using Apple Vision OCR.
Optimized for Apple Silicon with GPU/Neural Engine acceleration.

Converts PDF pages to images, then runs Vision OCR on each page.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import List, Optional, Sequence, Tuple


@dataclass(frozen=True)
class PageOcrResult:
    page_num: int
    text: str
    backend: str


def pdf_to_images(pdf_path: Path, output_dir: Path, dpi: int = 200) -> List[Tuple[int, Path]]:
    """
    Convert PDF pages to images using PyMuPDF (fitz).
    Returns list of (page_num, image_path) tuples.
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        raise RuntimeError(
            "PyMuPDF is required for PDF processing. Install with: pip install pymupdf"
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(str(pdf_path))

    pages: List[Tuple[int, Path]] = []
    zoom = dpi / 72  # 72 is the default PDF DPI
    matrix = fitz.Matrix(zoom, zoom)

    for page_num in range(len(doc)):
        page = doc[page_num]
        pix = page.get_pixmap(matrix=matrix)

        image_path = output_dir / f"page_{page_num + 1:04d}.png"
        pix.save(str(image_path))
        pages.append((page_num + 1, image_path))

    doc.close()
    return pages


def vision_ocr_image(image_path: Path, languages: Optional[List[str]] = None, fast: bool = False) -> str:
    """Run Apple Vision OCR on an image file."""
    try:
        from Foundation import NSURL  # type: ignore
        import Vision  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "Vision OCR requires macOS + PyObjC. Install with: "
            "pip install pyobjc-core pyobjc-framework-Vision pyobjc-framework-Cocoa"
        ) from e

    nsurl = NSURL.fileURLWithPath_(str(image_path))

    def _completion_handler(_request, _error):
        return

    request = Vision.VNRecognizeTextRequest.alloc().initWithCompletionHandler_(_completion_handler)
    request.setUsesLanguageCorrection_(True)

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


def write_markdown(
    results: Sequence[PageOcrResult],
    output_path: Path,
    pdf_path: Path,
) -> None:
    """Write OCR results to a Markdown file."""
    output_path.parent.mkdir(parents=True, exist_ok=True)

    lines: List[str] = []
    lines.append(f"# OCR: {pdf_path.name}")
    lines.append("")
    lines.append(f"- Source: `{pdf_path}`")
    lines.append(f"- Pages: {len(results)}")
    lines.append("")

    for r in results:
        lines.append(f"## Page {r.page_num}")
        lines.append("")
        lines.append((r.text or "").rstrip())
        lines.append("")
        lines.append("---")
        lines.append("")

    output_path.write_text("\n".join(lines), encoding="utf-8")


def write_text(
    results: Sequence[PageOcrResult],
    output_path: Path,
) -> None:
    """Write OCR results to a plain text file."""
    output_path.parent.mkdir(parents=True, exist_ok=True)

    lines: List[str] = []
    for r in results:
        lines.append(f"=== Page {r.page_num} ===")
        lines.append("")
        lines.append((r.text or "").rstrip())
        lines.append("")
        lines.append("")

    output_path.write_text("\n".join(lines), encoding="utf-8")


def write_jsonl(
    results: Sequence[PageOcrResult],
    output_path: Path,
) -> None:
    """Write OCR results to a JSONL file."""
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as f:
        for r in results:
            f.write(json.dumps({
                "page": r.page_num,
                "text": r.text,
                "backend": r.backend,
            }, ensure_ascii=False) + "\n")


def process_pdf(
    pdf_path: Path,
    output_path: Optional[Path] = None,
    output_format: str = "markdown",
    dpi: int = 200,
    workers: int = 8,
    languages: Optional[List[str]] = None,
    fast: bool = False,
    keep_images: bool = False,
    images_dir: Optional[Path] = None,
) -> Sequence[PageOcrResult]:
    """
    Extract text from a PDF using Apple Vision OCR.

    Args:
        pdf_path: Path to the PDF file
        output_path: Path to write the output (optional)
        output_format: Output format: markdown, text, or jsonl
        dpi: Resolution for rendering PDF pages (default: 200)
        workers: Number of parallel OCR workers (default: 8)
        languages: Recognition languages for Vision OCR
        fast: Use faster (less accurate) recognition
        keep_images: Keep the extracted page images
        images_dir: Directory to save page images (if keep_images)

    Returns:
        List of PageOcrResult objects
    """
    pdf_path = Path(pdf_path)
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    print(f"Processing: {pdf_path}", file=sys.stderr)
    print(f"DPI: {dpi}, Workers: {workers}", file=sys.stderr)

    # Determine where to store images
    if keep_images and images_dir:
        img_dir = Path(images_dir)
        img_dir.mkdir(parents=True, exist_ok=True)
        temp_context = None
    else:
        temp_context = tempfile.TemporaryDirectory()
        img_dir = Path(temp_context.name)

    try:
        # Convert PDF to images
        print("Converting PDF pages to images...", file=sys.stderr)
        pages = pdf_to_images(pdf_path, img_dir, dpi=dpi)
        print(f"Converted {len(pages)} pages", file=sys.stderr)

        # Progress tracking
        completed = [0]
        print_lock = Lock()
        total = len(pages)

        def process_page(page_info: Tuple[int, Path]) -> PageOcrResult:
            page_num, image_path = page_info
            text = vision_ocr_image(image_path, languages=languages, fast=fast)

            with print_lock:
                completed[0] += 1
                print(f"  [{completed[0]}/{total}] Page {page_num}", file=sys.stderr)

            return PageOcrResult(page_num=page_num, text=text, backend="vision")

        # OCR in parallel
        print("Running OCR...", file=sys.stderr)
        results_map: dict[int, PageOcrResult] = {}

        if workers == 1:
            for page_info in pages:
                result = process_page(page_info)
                results_map[result.page_num] = result
        else:
            with ThreadPoolExecutor(max_workers=workers) as executor:
                future_to_page = {executor.submit(process_page, p): p[0] for p in pages}
                for future in as_completed(future_to_page):
                    page_num = future_to_page[future]
                    try:
                        result = future.result()
                        results_map[result.page_num] = result
                    except Exception as e:
                        print(f"ERROR on page {page_num}: {e}", file=sys.stderr)
                        results_map[page_num] = PageOcrResult(
                            page_num=page_num,
                            text=f"[ERROR: {e}]",
                            backend="error"
                        )

        # Sort by page number
        results = [results_map[p[0]] for p in pages]

        # Write output if path provided
        if output_path:
            output_path = Path(output_path)
            if output_format == "markdown":
                write_markdown(results, output_path, pdf_path)
            elif output_format == "text":
                write_text(results, output_path)
            elif output_format == "jsonl":
                write_jsonl(results, output_path)
            else:
                raise ValueError(f"Unknown output format: {output_format}")
            print(f"Output written to: {output_path}", file=sys.stderr)

        print(f"Done! Processed {len(results)} pages.", file=sys.stderr)
        return results

    finally:
        if temp_context is not None:
            temp_context.cleanup()


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Extract text from PDF using Apple Vision OCR (Apple Silicon optimized)"
    )
    parser.add_argument("pdf", help="Input PDF file")
    parser.add_argument(
        "-o", "--output",
        help="Output file path (default: <pdf_name>.md)",
    )
    parser.add_argument(
        "-f", "--format",
        default="markdown",
        choices=["markdown", "text", "jsonl"],
        help="Output format (default: markdown)",
    )
    parser.add_argument(
        "--dpi",
        type=int,
        default=200,
        help="DPI for rendering PDF pages (default: 200, higher = better quality but slower)",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=os.cpu_count() or 8,
        help="Number of parallel OCR workers (default: number of CPU cores)",
    )
    parser.add_argument(
        "--languages",
        default="en-US",
        help="Comma-separated recognition languages (default: en-US)",
    )
    parser.add_argument(
        "--fast",
        action="store_true",
        help="Use faster (less accurate) text recognition",
    )
    parser.add_argument(
        "--keep-images",
        action="store_true",
        help="Keep the extracted page images",
    )
    parser.add_argument(
        "--images-dir",
        help="Directory to save page images (requires --keep-images)",
    )
    parser.add_argument(
        "--stdout",
        action="store_true",
        help="Print extracted text to stdout instead of writing to file",
    )

    args = parser.parse_args(argv)

    pdf_path = Path(args.pdf)

    # Determine output path
    if args.stdout:
        output_path = None
    elif args.output:
        output_path = Path(args.output)
    else:
        ext = {"markdown": ".md", "text": ".txt", "jsonl": ".jsonl"}[args.format]
        output_path = pdf_path.with_suffix(ext)

    # Parse languages
    languages = None
    if args.languages:
        languages = [s.strip() for s in args.languages.split(",") if s.strip()]

    results = process_pdf(
        pdf_path=pdf_path,
        output_path=output_path,
        output_format=args.format,
        dpi=args.dpi,
        workers=args.workers,
        languages=languages,
        fast=args.fast,
        keep_images=args.keep_images,
        images_dir=Path(args.images_dir) if args.images_dir else None,
    )

    # Print to stdout if requested
    if args.stdout:
        for r in results:
            print(f"=== Page {r.page_num} ===")
            print()
            print(r.text)
            print()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
