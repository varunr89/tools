#!/Users/varunr/projects/test/venv311/bin/python3
"""
Safari Markdown Exporter
Extracts main content from HTML and saves as markdown with frontmatter.
"""

import sys
import re
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

try:
    from trafilatura import extract
except ImportError:
    print("ERROR: trafilatura not installed. Run: pip install trafilatura", file=sys.stderr)
    sys.exit(1)


# Base path for saving markdown files
OBSIDIAN_BASE = Path.home() / "Library/Mobile Documents/iCloud~md~obsidian/Documents/Varun/Saved Pages"


def sanitize_filename(title: str, max_length: int = 100) -> str:
    """Remove/replace characters invalid for filenames."""
    # Replace problematic characters
    cleaned = re.sub(r'[/:*?"<>|\\]', '-', title)
    # Collapse multiple spaces/dashes
    cleaned = re.sub(r'[-\s]+', ' ', cleaned).strip()
    # Truncate
    if len(cleaned) > max_length:
        cleaned = cleaned[:max_length].rsplit(' ', 1)[0]
    return cleaned.strip(' -')


def get_domain(url: str) -> str:
    """Extract domain, stripping www. prefix."""
    parsed = urlparse(url)
    domain = parsed.netloc
    if domain.startswith('www.'):
        domain = domain[4:]
    return domain


def get_next_counter(folder: Path) -> int:
    """Get next counter value for a domain folder."""
    counter_file = folder / ".counter"
    try:
        if counter_file.exists():
            return int(counter_file.read_text().strip()) + 1
    except (ValueError, IOError):
        pass

    # Fallback: count existing files
    existing = list(folder.glob("*.md"))
    return len(existing) + 1


def save_counter(folder: Path, value: int):
    """Save counter value."""
    counter_file = folder / ".counter"
    counter_file.write_text(str(value))


def create_frontmatter(title: str, url: str, domain: str) -> str:
    """Create YAML frontmatter."""
    today = date.today().isoformat()
    # Escape quotes in title
    safe_title = title.replace('"', '\\"')
    return f'''---
title: "{safe_title}"
url: {url}
domain: {domain}
date_saved: {today}
---

'''


def main():
    if len(sys.argv) < 3:
        print("Usage: safari-markdown-exporter.py <html_file> <url> [title]", file=sys.stderr)
        sys.exit(1)

    html_file = sys.argv[1]
    url = sys.argv[2]
    title = sys.argv[3] if len(sys.argv) > 3 else "Untitled"

    # Read HTML from temp file
    try:
        with open(html_file, 'r', encoding='utf-8') as f:
            html_content = f.read()
    except IOError as e:
        print(f"ERROR: Cannot read HTML file: {e}", file=sys.stderr)
        sys.exit(1)

    # Extract main content as markdown
    markdown_content = extract(
        html_content,
        output_format='markdown',
        include_links=True,
        include_images=True,
        include_tables=True,
    )

    if not markdown_content:
        markdown_content = "*Content extraction failed - page may not have extractable article content.*"

    # Setup folder structure
    domain = get_domain(url)
    domain_folder = OBSIDIAN_BASE / domain
    domain_folder.mkdir(parents=True, exist_ok=True)

    # Get counter and build filename
    counter = get_next_counter(domain_folder)
    today = date.today().isoformat()
    safe_title = sanitize_filename(title)
    filename = f"{counter:03d} - {today} - {safe_title}.md"

    # Build full content with frontmatter
    full_content = create_frontmatter(title, url, domain) + markdown_content

    # Save file
    output_path = domain_folder / filename
    output_path.write_text(full_content, encoding='utf-8')

    # Update counter
    save_counter(domain_folder, counter)

    # Print filename for AppleScript notification
    print(filename)


if __name__ == "__main__":
    main()
