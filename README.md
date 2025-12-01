# Tools

A collection of automation tools for specific workflows.

## Tools

### Safari PDF Exporter (`safari-pdf-exporter.scpt`)

An AppleScript that exports the current Safari page to PDF with auto-incrementing filenames, then scrolls to the bottom and advances to the next page. Designed for batch-exporting sequential content (e.g., course lessons).

**Features:**
- Auto-incrementing counter (001, 002, 003...)
- Cleans page title for safe filenames
- Saves PDFs to Documents folder
- Scrolls page to bottom after export
- Advances to next page (Ctrl+>)

**Setup:** Create an Automator Quick Action to run the script via keyboard shortcut.

### MP3 Transcriber (`transcribe.py`)

Fast MP3 transcription using MLX Whisper, optimized for Apple Silicon GPU acceleration.

**Requirements:**
- Python 3.9+
- Apple Silicon Mac (M1/M2/M3)
- `mlx-whisper` package

**Usage:**
```bash
python3 -m venv venv
source venv/bin/activate
pip install mlx-whisper

python transcribe.py --input /path/to/mp3s --output transcripts
```

**Options:**
- `--input` - Directory containing MP3 files (default: current directory)
- `--output` - Output directory for transcripts (default: `transcripts`)
- `--model` - MLX Whisper model (default: `mlx-community/whisper-large-v3-turbo`)
