#!/Users/varunr/projects/test/venv311/bin/python3
"""
Safari Markdown Exporter
Extracts main content from HTML/PDF and saves as markdown with frontmatter.
Supports image downloading for web pages and PDF archival.
"""

import sys
import re
import shutil
from datetime import date
from pathlib import Path
from urllib.parse import urlparse, urljoin, unquote
from urllib.request import urlopen, Request
from urllib.error import URLError

try:
    from trafilatura import extract
except ImportError:
    print("ERROR: trafilatura not installed. Run: pip install trafilatura", file=sys.stderr)
    sys.exit(1)

try:
    import fitz  # pymupdf
except ImportError:
    fitz = None  # PDF support optional

try:
    from html.parser import HTMLParser
except ImportError:
    HTMLParser = None


# Base path for saving markdown files
OBSIDIAN_BASE = Path.home() / "Library/Mobile Documents/iCloud~md~obsidian/Documents/Varun/Saved Pages"


def sanitize_filename(title: str, max_length: int = 100) -> str:
    """Remove/replace characters invalid for filenames."""
    cleaned = re.sub(r'[/:*?"<>|\\]', '-', title)
    cleaned = re.sub(r'[-\s]+', ' ', cleaned).strip()
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
    existing = list(folder.glob("*.md"))
    return len(existing) + 1


def save_counter(folder: Path, value: int):
    """Save counter value."""
    counter_file = folder / ".counter"
    counter_file.write_text(str(value))


def extract_figures_from_html(html_content: str, base_url: str) -> list[dict]:
    """Extract figures with their labels, images, and captions from HTML.

    Returns list of dicts with keys: label, alt, src, caption
    """
    figures = []

    # Pattern to find <figure> elements with their content
    figure_pattern = re.compile(
        r'<figure[^>]*>(.*?)</figure>',
        re.IGNORECASE | re.DOTALL
    )

    # Patterns for content within figures
    img_pattern = re.compile(r'<img[^>]*\ssrc=["\']([^"\']+)["\'][^>]*>', re.IGNORECASE)
    alt_pattern = re.compile(r'\salt=["\']([^"\']*)["\']', re.IGNORECASE)
    caption_pattern = re.compile(r'<figcaption[^>]*>(.*?)</figcaption>', re.IGNORECASE | re.DOTALL)
    label_pattern = re.compile(r'(Figure\s+[\d\-\.]+)', re.IGNORECASE)

    for figure_match in figure_pattern.finditer(html_content):
        figure_content = figure_match.group(1)

        # Find image
        img_match = img_pattern.search(figure_content)
        if not img_match:
            continue

        src = img_match.group(0)
        src_url_match = re.search(r'src=["\']([^"\']+)["\']', src)
        if not src_url_match:
            continue

        src_url = src_url_match.group(1)

        # Skip non-content images
        if any(skip in src_url.lower() for skip in ['1x1', 'pixel', 'track', 'beacon', '.svg', 'data:']):
            continue

        # Resolve relative URLs
        if not src_url.startswith(('http://', 'https://')):
            src_url = urljoin(base_url, src_url)

        # Get alt text
        alt_match = alt_pattern.search(src)
        alt_text = alt_match.group(1) if alt_match else ""

        # Get caption
        caption_match = caption_pattern.search(figure_content)
        caption = ""
        label = ""
        if caption_match:
            # Strip HTML tags from caption
            caption = re.sub(r'<[^>]+>', '', caption_match.group(1)).strip()
            # Extract figure label (e.g., "Figure 2-1"), strip trailing punctuation
            label_match = label_pattern.search(caption)
            if label_match:
                label = label_match.group(1).rstrip('.')

        figures.append({
            'label': label,
            'alt': alt_text,
            'src': src_url,
            'caption': caption
        })

    return figures


def extract_images_from_html(html_content: str, base_url: str) -> list[tuple[str, str]]:
    """Extract standalone images (not in figures) from HTML.

    Returns list of (alt_text, url) tuples.
    """
    images = []

    # First, remove all figure elements to avoid duplicates
    html_without_figures = re.sub(r'<figure[^>]*>.*?</figure>', '', html_content, flags=re.IGNORECASE | re.DOTALL)

    # Pattern to find img tags with src attribute
    img_pattern = re.compile(
        r'<img[^>]*\ssrc=["\']([^"\']+)["\'][^>]*>',
        re.IGNORECASE | re.DOTALL
    )
    alt_pattern = re.compile(r'\salt=["\']([^"\']*)["\']', re.IGNORECASE)

    for match in img_pattern.finditer(html_without_figures):
        img_tag = match.group(0)
        src = match.group(1)

        # Skip tiny images (likely icons/trackers), data URIs, and SVGs
        if any(skip in src.lower() for skip in ['1x1', 'pixel', 'track', 'beacon', '.svg', 'data:']):
            continue

        # Get alt text if present
        alt_match = alt_pattern.search(img_tag)
        alt_text = alt_match.group(1) if alt_match else ""

        # Resolve relative URLs
        if not src.startswith(('http://', 'https://')):
            src = urljoin(base_url, src)

        images.append((alt_text, src))

    return images


def create_frontmatter(title: str, url: str, domain: str, source_pdf: str = None) -> str:
    """Create YAML frontmatter."""
    today = date.today().isoformat()
    safe_title = title.replace('"', '\\"')

    lines = [
        '---',
        f'title: "{safe_title}"',
        f'url: {url}',
        f'domain: {domain}',
        f'date_saved: {today}',
    ]

    if source_pdf:
        lines.append(f'source_pdf: "[[{source_pdf}]]"')

    lines.append('---')
    lines.append('')
    lines.append('')

    return '\n'.join(lines)


def extract_pdf_text(pdf_path: Path) -> str:
    """Extract text from PDF using pymupdf."""
    if fitz is None:
        return "*PDF extraction unavailable - pymupdf not installed.*"

    try:
        doc = fitz.open(pdf_path)
        text_parts = []
        for page in doc:
            text_parts.append(page.get_text())
        doc.close()
        return '\n\n'.join(text_parts).strip()
    except Exception as e:
        return f"*PDF extraction failed: {e}*"


def download_image(img_url: str, asset_folder: Path, base_url: str) -> str | None:
    """Download an image and return the local filename, or None if failed."""
    # Resolve relative URLs
    if not img_url.startswith(('http://', 'https://', 'data:')):
        img_url = urljoin(base_url, img_url)

    # Skip data URIs and other non-http
    if not img_url.startswith(('http://', 'https://')):
        return None

    try:
        # Extract filename from URL
        parsed = urlparse(img_url)
        filename = unquote(Path(parsed.path).name)

        # Skip if no valid filename
        if not filename or '.' not in filename:
            filename = f"image_{hash(img_url) % 10000}.jpg"

        # Handle duplicate filenames
        target_path = asset_folder / filename
        if target_path.exists():
            stem = target_path.stem
            suffix = target_path.suffix
            counter = 2
            while target_path.exists():
                target_path = asset_folder / f"{stem}-{counter}{suffix}"
                counter += 1
            filename = target_path.name

        # Download
        req = Request(img_url, headers={'User-Agent': 'Mozilla/5.0 Safari/537.36'})
        with urlopen(req, timeout=10) as response:
            target_path.write_bytes(response.read())

        return filename
    except (URLError, IOError, ValueError):
        return None


def process_images(markdown: str, asset_folder: Path, base_url: str, folder_name: str) -> str:
    """Download images and rewrite markdown links to local paths."""
    # Pattern for markdown images: ![alt](url)
    img_pattern = re.compile(r'!\[([^\]]*)\]\(([^)]+)\)')

    # Find all images first for logging
    all_images = img_pattern.findall(markdown)
    print(f"DEBUG: Found {len(all_images)} image(s) in markdown", file=sys.stderr)
    for alt, url in all_images:
        print(f"DEBUG:   [{alt[:30]}...] -> {url[:80]}...", file=sys.stderr)

    downloaded_any = False

    def replace_image(match):
        nonlocal downloaded_any
        alt_text = match.group(1)
        img_url = match.group(2)

        # Create asset folder on first successful download
        if not asset_folder.exists():
            asset_folder.mkdir(parents=True, exist_ok=True)

        local_filename = download_image(img_url, asset_folder, base_url)

        if local_filename:
            downloaded_any = True
            # Use relative path from markdown file to asset folder
            local_path = f"{folder_name}/{local_filename}"
            print(f"DEBUG:   Downloaded: {local_filename}", file=sys.stderr)
            return f'![{alt_text}]({local_path})'
        else:
            # Keep original URL if download failed
            print(f"DEBUG:   Failed to download: {img_url[:60]}...", file=sys.stderr)
            return match.group(0)

    result = img_pattern.sub(replace_image, markdown)

    # Clean up empty asset folder if no images downloaded
    if not downloaded_any and asset_folder.exists() and not any(asset_folder.iterdir()):
        asset_folder.rmdir()

    return result


def process_html(html_content: str, url: str, title: str, domain_folder: Path,
                 counter: int, today: str, safe_title: str) -> str:
    """Process HTML content: extract markdown, download images."""
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

    # Setup asset folder name (matches markdown filename without .md)
    folder_name = f"{counter:03d} - {today} - {safe_title}"
    asset_folder = domain_folder / folder_name

    # Check if trafilatura included any images
    img_pattern = re.compile(r'!\[[^\]]*\]\([^)]+\)')
    trafilatura_images = img_pattern.findall(markdown_content)

    if trafilatura_images:
        # Process images that trafilatura found
        markdown_content = process_images(markdown_content, asset_folder, url, folder_name)
    else:
        # trafilatura didn't include images - extract from HTML and insert inline
        figures = extract_figures_from_html(html_content, url)
        standalone_images = extract_images_from_html(html_content, url)

        print(f"DEBUG: trafilatura found 0 images, extracting {len(figures)} figures + {len(standalone_images)} standalone from HTML", file=sys.stderr)

        if figures or standalone_images:
            asset_folder.mkdir(parents=True, exist_ok=True)

        # Process figures - insert inline after their references
        unmatched_figures = []
        for fig in figures:
            local_filename = download_image(fig['src'], asset_folder, url)
            if not local_filename:
                continue

            local_path = f"{folder_name}/{local_filename}"
            img_md = f"\n\n![{fig['alt']}]({local_path})\n*{fig['caption']}*\n"
            print(f"DEBUG:   Downloaded figure: {local_filename} ({fig['label']})", file=sys.stderr)

            # Try to insert after figure reference in markdown
            inserted = False
            if fig['label']:
                # Look for references like "Figure 2-1" or "[Figure 2-1]"
                # Insert image on the line after the reference
                ref_patterns = [
                    re.compile(r'(\[' + re.escape(fig['label']) + r'\][^\n]*\n)', re.IGNORECASE),
                    re.compile(r'(' + re.escape(fig['label']) + r'[^\n]*\n)', re.IGNORECASE),
                ]
                for ref_pattern in ref_patterns:
                    if ref_pattern.search(markdown_content):
                        # Insert after first match only
                        markdown_content = ref_pattern.sub(r'\1' + img_md, markdown_content, count=1)
                        inserted = True
                        break

            if not inserted:
                unmatched_figures.append((fig['alt'], local_path, fig['caption']))

        # Process standalone images - append at end
        unmatched_images = []
        for alt_text, img_url in standalone_images:
            local_filename = download_image(img_url, asset_folder, url)
            if local_filename:
                local_path = f"{folder_name}/{local_filename}"
                unmatched_images.append((alt_text, local_path))
                print(f"DEBUG:   Downloaded standalone: {local_filename}", file=sys.stderr)

        # Append any unmatched figures and standalone images at the end
        if unmatched_figures or unmatched_images:
            markdown_content += "\n\n---\n\n## Figures\n\n"
            for alt, path, caption in unmatched_figures:
                markdown_content += f"![{alt}]({path})\n*{caption}*\n\n"
            for alt, path in unmatched_images:
                markdown_content += f"![{alt}]({path})\n\n"

    # Build filename
    filename = f"{folder_name}.md"
    domain = get_domain(url)

    # Build full content
    full_content = create_frontmatter(title, url, domain) + markdown_content

    # Save file
    output_path = domain_folder / filename
    output_path.write_text(full_content, encoding='utf-8')

    return filename


def process_pdf(pdf_path: Path, url: str, title: str, domain_folder: Path,
                counter: int, today: str, safe_title: str) -> str:
    """Process PDF: extract text, archive original PDF."""
    # Extract text
    markdown_content = extract_pdf_text(pdf_path)

    # Setup asset folder
    folder_name = f"{counter:03d} - {today} - {safe_title}"
    asset_folder = domain_folder / folder_name
    asset_folder.mkdir(parents=True, exist_ok=True)

    # Copy PDF to asset folder
    pdf_dest = asset_folder / "source.pdf"
    shutil.copy2(pdf_path, pdf_dest)

    # Build filename
    filename = f"{folder_name}.md"
    domain = get_domain(url)

    # Relative path for frontmatter link
    source_pdf_path = f"{folder_name}/source.pdf"

    # Build full content
    full_content = create_frontmatter(title, url, domain, source_pdf_path) + markdown_content

    # Save file
    output_path = domain_folder / filename
    output_path.write_text(full_content, encoding='utf-8')

    return filename


def main():
    if len(sys.argv) < 3:
        print("Usage: safari-markdown-exporter.py <input_file> <url> [title] [--pdf]", file=sys.stderr)
        sys.exit(1)

    input_file = Path(sys.argv[1])
    url = sys.argv[2]
    title = sys.argv[3] if len(sys.argv) > 3 and not sys.argv[3].startswith('--') else "Untitled"
    is_pdf = '--pdf' in sys.argv or url.lower().endswith('.pdf')

    # Setup folder structure
    domain = get_domain(url)
    domain_folder = OBSIDIAN_BASE / domain
    domain_folder.mkdir(parents=True, exist_ok=True)

    # Get counter and prepare filename components
    counter = get_next_counter(domain_folder)
    today = date.today().isoformat()
    safe_title = sanitize_filename(title)

    if is_pdf:
        filename = process_pdf(input_file, url, title, domain_folder, counter, today, safe_title)
    else:
        # Read HTML content
        try:
            html_content = input_file.read_text(encoding='utf-8')
        except IOError as e:
            print(f"ERROR: Cannot read input file: {e}", file=sys.stderr)
            sys.exit(1)
        filename = process_html(html_content, url, title, domain_folder, counter, today, safe_title)

    # Update counter
    save_counter(domain_folder, counter)

    # Print filename for AppleScript notification
    print(filename)


if __name__ == "__main__":
    main()
