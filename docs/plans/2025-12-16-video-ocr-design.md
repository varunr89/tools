# Video OCR and Transcript Extraction Design

## Problem

Extract text from a screen recording of a scrolling transcript (Speaker-Timestamp-Text format) using OCR.

## Solution Overview

Two-part pipeline separating reusable OCR from domain-specific cleaning:

```
video.mov → video_ocr.py → raw_ocr.jsonl → transcript_cleaner.py → transcript.md
```

## Part 1: video_ocr.py (Reusable)

**Purpose:** Extract text from any video using Apple Vision framework.

**Interface:**
```bash
python video_ocr.py input.mov -o output.jsonl --fps 3
```

**Components:**

1. **Frame extraction** - ffmpeg extracts frames at specified fps:
   ```bash
   ffmpeg -i input.mov -vf "fps=3" frames/%04d.png
   ```

2. **Apple Vision OCR** - VNRecognizeTextRequest via PyObjC. Runs on Neural Engine/GPU automatically.

3. **Parallel processing** - concurrent.futures for frame processing. Vision handles GPU scheduling.

4. **Output format** (JSONL):
   ```json
   {"frame": 1, "time_sec": 0.0, "text": "..."}
   {"frame": 2, "time_sec": 0.33, "text": "..."}
   ```

**Dependencies:**
- pyobjc-framework-Vision
- ffmpeg (already installed)

## Part 2: transcript_cleaner.py (Custom)

**Purpose:** Parse raw OCR into clean, deduplicated transcript.

**Interface:**
```bash
python transcript_cleaner.py raw_ocr.jsonl -o transcript.md
```

**Components:**

1. **Parse entries** - Regex extracts Speaker, Timestamp, Text from each frame's OCR output.

2. **Deduplicate** - Use transcript timestamp as unique key. Keep longest text version when same timestamp appears multiple times.

3. **Output format** (Markdown):
   ```markdown
   **Speaker A** (00:00:01)
   Hello, welcome to the meeting.

   **Speaker B** (00:00:05)
   Hi, thanks for having me.
   ```

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| OCR engine | Apple Vision | Native, fast, optimized for screen text |
| Frame sampling | Fixed 2-4 fps | Simple, sufficient for human-readable scroll speed |
| Deduplication | Timestamp-based | Timestamps are unique identifiers in transcript format |
| Intermediate format | JSONL | Easy to debug, process, and rerun cleaning |

## Usage

```bash
# Install dependency
pip install pyobjc-framework-Vision

# Extract OCR
python video_ocr.py ~/Desktop/recording.mov -o raw_ocr.jsonl --fps 3

# Clean transcript
python transcript_cleaner.py raw_ocr.jsonl -o transcript.md
```
