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

### Safari Markdown Exporter (`safari-markdown-exporter.scpt` + `safari-markdown-exporter.py`)

Extracts the main content from Safari web pages and saves as markdown files to Obsidian. Uses Safari's Reader Mode for cleaner extraction and trafilatura for content parsing.

**Features:**
- Extracts main article content (strips navigation, ads, sidebars)
- Toggles Safari Reader Mode for cleaner extraction (falls back gracefully)
- Saves to Obsidian vault organized by domain
- YAML frontmatter with title, URL, domain, and date
- Auto-incrementing counter per domain
- Scrolls page to bottom after export (visual confirmation)

**Output Structure:**
```
~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Varun/Saved Pages/
├── example.com/
│   ├── .counter
│   ├── 001 - 2024-12-14 - Article Title.md
│   └── 002 - 2024-12-14 - Another Article.md
└── docs.python.org/
    └── 001 - 2024-12-14 - Some Doc.md
```

**Requirements:**
- Python 3.11+ (uses venv at `venv311/`)
- `trafilatura` package

**Setup:**
```bash
source venv311/bin/activate
pip install trafilatura
```

Then create an Automator Quick Action:
1. Open Automator → New → Quick Action
2. Set "Workflow receives" to **no input** in **Safari**
3. Add action: Run AppleScript
4. Paste contents of `safari-markdown-exporter.scpt`
5. Save as "Export Page as Markdown"
6. Assign keyboard shortcut in System Settings → Keyboard → Keyboard Shortcuts → Services

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

### JPG OCR to Markdown (`ocr_jpgs_to_markdown.py`)

Extracts text from a directory of `.jpg/.jpeg` files into a single Markdown file (one section per image).

**Requirements:**
- Python 3.9+
- `tesseract` installed (fallback OCR backend)

**Usage:**
```bash
source venv/bin/activate

# Extract first 10 images to inspect results
python ocr_jpgs_to_markdown.py \
  --input ezgif-1c2d7a728cf1b200-jpg \
  --output training_plan_ocr.md \
  --limit 10 \
  --backend tesseract \
  --preprocess
```

**Notes:**
- `--backend auto` tries Apple's Vision OCR first (if available), then falls back to `tesseract`.
- `--preprocess` converts to grayscale, boosts contrast, and upscales before running `tesseract` (often helps on screenshots).

**MLX OCR (GPU) setup (optional):**
```bash
python3.11 -m venv venv311
source venv311/bin/activate
pip install mlx-ocr opencv-python pillow

# Run from your main venv, but use the 3.11 venv for the MLX worker:
source venv/bin/activate
python ocr_jpgs_to_markdown.py \
  --input ezgif-1c2d7a728cf1b200-jpg \
  --output training_plan_ocr_mlx.md \
  --backend mlx_ocr \
  --mlx-worker-python ./venv311/bin/python
```
