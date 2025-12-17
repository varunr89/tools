#!/usr/bin/env python3
"""
Clean and deduplicate OCR transcript output.
Parses Speaker-Timestamp-Text format and outputs clean markdown.
"""

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path


# Pattern for Speaker Timestamp Text format
# Matches: "Speaker Name 0:03" or "Speaker Name 12:34" or "Speaker Name 1:23:45"
ENTRY_PATTERN = re.compile(
    r'^([A-Za-z][A-Za-z ]+?)\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*$',
    re.MULTILINE
)


def parse_entries(text: str) -> list[dict]:
    """Parse OCR text into structured entries."""
    entries = []

    # Find all speaker-timestamp headers
    matches = list(ENTRY_PATTERN.finditer(text))

    for i, match in enumerate(matches):
        speaker = match.group(1).strip()
        timestamp = match.group(2)

        # Get text between this match and the next
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        content = text[start:end].strip()

        if content:
            entries.append({
                "speaker": speaker,
                "timestamp": timestamp,
                "text": content
            })

    return entries


def timestamp_to_seconds(ts: str) -> int:
    """Convert M:SS, MM:SS, or H:MM:SS to seconds for sorting."""
    parts = ts.split(":")
    if len(parts) == 3:
        h, m, s = map(int, parts)
        return h * 3600 + m * 60 + s
    elif len(parts) == 2:
        m, s = map(int, parts)
        return m * 60 + s
    return 0


def deduplicate_entries(all_entries: list[dict]) -> list[dict]:
    """Deduplicate entries by timestamp, keeping longest text."""
    by_timestamp = defaultdict(list)

    for entry in all_entries:
        key = entry["timestamp"]
        by_timestamp[key].append(entry)

    # For each timestamp, keep the entry with longest text
    deduped = []
    for timestamp, entries in by_timestamp.items():
        best = max(entries, key=lambda e: len(e["text"]))
        deduped.append(best)

    # Sort by timestamp
    deduped.sort(key=lambda e: timestamp_to_seconds(e["timestamp"]))

    return deduped


def format_markdown(entries: list[dict]) -> str:
    """Format entries as markdown."""
    lines = ["# Transcript", ""]

    for entry in entries:
        lines.append(f"**{entry['speaker']}** ({entry['timestamp']})")
        lines.append(entry["text"])
        lines.append("")

    return "\n".join(lines)


def process_jsonl(input_path: str, output_path: str):
    """Process JSONL file and output clean transcript."""
    print(f"Processing: {input_path}")

    # Read all frames
    all_entries = []
    frame_count = 0

    with open(input_path, "r", encoding="utf-8") as f:
        for line in f:
            frame = json.loads(line)
            frame_count += 1
            entries = parse_entries(frame["text"])
            all_entries.extend(entries)

    print(f"Parsed {len(all_entries)} entries from {frame_count} frames")

    # Deduplicate
    deduped = deduplicate_entries(all_entries)
    print(f"After deduplication: {len(deduped)} unique entries")

    # Format and write
    markdown = format_markdown(deduped)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(markdown)

    print(f"Done! Output: {output_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Clean OCR transcript output")
    parser.add_argument("input", help="Input JSONL file from video_ocr.py")
    parser.add_argument("-o", "--output", default="transcript.md", help="Output markdown file")

    args = parser.parse_args()
    process_jsonl(args.input, args.output)
