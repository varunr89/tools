import express, { Request, Response } from "express";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || process.argv[2] || "./claude-archive";

// CSS to inject for progressive disclosure
const INJECTED_CSS = `
<style id="viewer-enhancements">
/* All cells collapsed by default */
.cell:not([open]) .cell-content { display: none; }

/* Preview text in collapsed cells */
.cell-preview {
  flex: 1;
  color: var(--text-muted, #757575);
  font-weight: normal;
  font-size: var(--font-size-xs, 0.75rem);
  margin: 0 var(--spacing-sm, 8px);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.4;
}
.cell[open] .cell-preview { display: none; }

/* Adjust summary layout for preview */
.cell summary {
  align-items: flex-start !important;
  flex-wrap: wrap !important;
}
.cell summary .cell-label { flex-shrink: 0; }

/* Performance optimization */
.message {
  content-visibility: auto;
  contain-intrinsic-size: 1px 600px;
}
.cell {
  content-visibility: auto;
  contain: layout style paint;
  contain-intrinsic-size: 1px 400px;
}

/* Infinite scroll loading indicator */
#infinite-scroll-loader {
  text-align: center;
  padding: 20px;
  color: var(--text-muted, #757575);
}
#infinite-scroll-loader.loading::after {
  content: "Loading more...";
}
#infinite-scroll-loader.done::after {
  content: "End of conversation";
}
</style>
`;

// JavaScript for infinite scroll and cell enhancements
const INJECTED_JS = `
<script id="viewer-enhancements-js">
(function() {
  // Extract preview text from cell content
  function extractPreview(cellContent, maxLength = 400) {
    const text = cellContent.textContent || '';
    const cleaned = text.replace(/\\s+/g, ' ').trim();
    return cleaned.length > maxLength
      ? cleaned.substring(0, maxLength) + '...'
      : cleaned;
  }

  // Add preview to all cells
  function addPreviews() {
    document.querySelectorAll('.cell').forEach(cell => {
      if (cell.querySelector('.cell-preview')) return; // Already has preview

      const summary = cell.querySelector('summary');
      const content = cell.querySelector('.cell-content');
      const copyBtn = summary.querySelector('.cell-copy-btn');

      if (summary && content) {
        const preview = document.createElement('span');
        preview.className = 'cell-preview';
        preview.textContent = extractPreview(content);

        // Insert before copy button or at end
        if (copyBtn) {
          summary.insertBefore(preview, copyBtn);
        } else {
          summary.appendChild(preview);
        }
      }
    });
  }

  // Collapse all cells by default
  function collapseAllCells() {
    document.querySelectorAll('.cell[open]').forEach(cell => {
      cell.removeAttribute('open');
    });
  }

  // Infinite scroll state
  let currentPage = 1;
  let totalPages = 1;
  let isLoading = false;
  const pageMatch = window.location.pathname.match(/page-(\\d+)\\.html/);
  if (pageMatch) {
    currentPage = parseInt(pageMatch[1], 10);
  }

  // Detect total pages from pagination
  function detectTotalPages() {
    const pagination = document.querySelector('.pagination');
    if (pagination) {
      const links = pagination.querySelectorAll('a[href^="page-"]');
      links.forEach(link => {
        const match = link.href.match(/page-(\\d+)\\.html/);
        if (match) {
          const pageNum = parseInt(match[1], 10);
          if (pageNum > totalPages) totalPages = pageNum;
        }
      });
    }
  }

  // Load next page content
  async function loadNextPage() {
    if (isLoading || currentPage >= totalPages) return;

    isLoading = true;
    const loader = document.getElementById('infinite-scroll-loader');
    if (loader) loader.className = 'loading';

    const nextPage = currentPage + 1;
    const nextUrl = window.location.pathname.replace(
      /page-\\d+\\.html/,
      'page-' + String(nextPage).padStart(3, '0') + '.html'
    );

    try {
      const response = await fetch(nextUrl);
      if (!response.ok) throw new Error('Page not found');

      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      // Get messages from next page
      const messages = doc.querySelectorAll('.message');
      const container = document.querySelector('.container');
      const pagination = document.querySelector('.pagination');

      if (container && messages.length > 0) {
        messages.forEach(msg => {
          const clone = document.importNode(msg, true);
          container.insertBefore(clone, pagination || loader);
        });

        // Process new content
        addPreviews();
        collapseAllCells();
        currentPage = nextPage;
      }
    } catch (err) {
      console.error('Failed to load next page:', err);
    } finally {
      isLoading = false;
      const loader = document.getElementById('infinite-scroll-loader');
      if (loader) {
        loader.className = currentPage >= totalPages ? 'done' : '';
      }
    }
  }

  // Set up infinite scroll observer
  function setupInfiniteScroll() {
    // Add loader element
    const container = document.querySelector('.container');
    const pagination = document.querySelector('.pagination');

    if (container) {
      const loader = document.createElement('div');
      loader.id = 'infinite-scroll-loader';
      if (pagination) {
        container.insertBefore(loader, pagination);
        pagination.style.display = 'none'; // Hide pagination
      } else {
        container.appendChild(loader);
      }

      // Observe loader for infinite scroll
      const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
          loadNextPage();
        }
      }, { rootMargin: '200px' });

      observer.observe(loader);
    }
  }

  // Initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    detectTotalPages();
    collapseAllCells();
    addPreviews();
    setupInfiniteScroll();
  }
})();
</script>
`;

// Inject enhancements into HTML
function enhanceHtml(html: string): string {
  const $ = cheerio.load(html);

  // Inject CSS before </head>
  $("head").append(INJECTED_CSS);

  // Inject JS before </body>
  $("body").append(INJECTED_JS);

  return $.html();
}

// Serve enhanced HTML files
app.get(/.*\.html$/, (req: Request, res: Response) => {
  const filePath = join(ARCHIVE_DIR, req.path);

  if (!existsSync(filePath)) {
    res.status(404).send("File not found");
    return;
  }

  try {
    const html = readFileSync(filePath, "utf-8");
    const enhanced = enhanceHtml(html);
    res.type("html").send(enhanced);
  } catch (err) {
    console.error("Error serving file:", err);
    res.status(500).send("Error serving file");
  }
});

// Serve static assets (CSS, JS, images)
app.use(express.static(ARCHIVE_DIR));

// List available projects
app.get("/api/projects", (req: Request, res: Response) => {
  try {
    const projects = readdirSync(ARCHIVE_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    res.json({ projects });
  } catch (err) {
    res.status(500).json({ error: "Failed to list projects" });
  }
});

app.listen(PORT, () => {
  console.log(`
Claude Transcript Viewer running at http://localhost:${PORT}

Serving archive from: ${ARCHIVE_DIR}

Usage:
  npm run dev                    # Development mode with hot reload
  npm run dev -- /path/to/archive  # Specify archive directory

Open http://localhost:${PORT} to browse transcripts.
`);
});
