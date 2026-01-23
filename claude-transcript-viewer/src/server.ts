#!/usr/bin/env node
import express, { Request, Response } from "express";
import { readFileSync, existsSync, readdirSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { spawn } from "child_process";
import * as cheerio from "cheerio";
import { createDatabase, getDatabase, closeDatabase } from "./db/index.js";
import { searchHybrid, searchFTS, SearchOptions } from "./api/search.js";
import { generateSnippet, highlightTerms } from "./api/snippets.js";
import { createEmbeddingClient, EmbeddingClient } from "./embeddings/client.js";
import { getConfig } from "./config.js";
import { runIndexer } from "./indexer/index.js";

const app = express();
const config = getConfig();
const PORT = process.env.PORT || 3000;
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || process.argv[2] || "./claude-archive";
const SOURCE_DIR = process.env.SOURCE_DIR || process.argv[3] || "";
const DATABASE_PATH = process.env.DATABASE_PATH || join(ARCHIVE_DIR, ".search.db");

// Initialize database and embedding client
let embeddingClient: EmbeddingClient | undefined;

// Background indexing state
let indexingStatus: {
  isIndexing: boolean;
  progress?: string;
  lastError?: string;
  lastStats?: {
    added: number;
    modified: number;
    deleted: number;
    chunks: number;
  };
} = { isIndexing: false };

// Archive generation state
let archiveStatus: {
  isGenerating: boolean;
  progress?: string;
  lastError?: string;
  lastRun?: string;
} = { isGenerating: false };

// Cache mapping database project slugs to archive directory names
let projectToArchiveMap: Map<string, string> = new Map();

// Generate HTML archive using claude-code-transcripts Python CLI
async function generateArchive(): Promise<boolean> {
  if (!SOURCE_DIR || archiveStatus.isGenerating) {
    return false;
  }

  if (!existsSync(SOURCE_DIR)) {
    console.log(`Source directory not found: ${SOURCE_DIR} - skipping archive generation`);
    return false;
  }

  // Ensure archive directory exists
  if (!existsSync(ARCHIVE_DIR)) {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  console.log(`Generating HTML archive from ${SOURCE_DIR} to ${ARCHIVE_DIR}...`);
  archiveStatus.isGenerating = true;
  archiveStatus.progress = "Starting...";

  return new Promise((resolve) => {
    // Use uv run to execute claude-code-transcripts all command
    const proc = spawn("uv", [
      "run",
      "claude-code-transcripts",
      "all",
      "-s",
      SOURCE_DIR,
      "-o",
      ARCHIVE_DIR,
      "--include-agents",
      "-q",
    ], {
      cwd: process.env.TRANSCRIPTS_CLI_PATH || undefined,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      const line = data.toString();
      stdout += line;
      // Update progress from output
      const match = line.match(/Processing|Generating|Writing/i);
      if (match) {
        archiveStatus.progress = line.trim().slice(0, 50);
      }
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      archiveStatus.isGenerating = false;
      archiveStatus.lastRun = new Date().toISOString();

      if (code === 0) {
        archiveStatus.progress = "Complete";
        console.log("Archive generation complete");
        resolve(true);
      } else {
        archiveStatus.lastError = stderr || `Exit code ${code}`;
        console.error("Archive generation failed:", stderr || `Exit code ${code}`);
        resolve(false);
      }
    });

    proc.on("error", (err) => {
      archiveStatus.isGenerating = false;
      archiveStatus.lastError = err.message;
      console.error("Failed to spawn claude-code-transcripts:", err.message);
      console.log("Make sure claude-code-transcripts is installed: pip install claude-code-transcripts");
      resolve(false);
    });
  });
}

// Start background indexing if SOURCE_DIR is provided
async function startBackgroundIndexing() {
  if (!SOURCE_DIR || indexingStatus.isIndexing) {
    return;
  }

  if (!existsSync(SOURCE_DIR)) {
    console.log(`Source directory not found: ${SOURCE_DIR} - skipping auto-indexing`);
    return;
  }

  console.log(`Starting background indexing from ${SOURCE_DIR}...`);
  indexingStatus.isIndexing = true;
  indexingStatus.progress = "Starting...";

  try {
    const stats = await runIndexer({
      sourceDir: SOURCE_DIR,
      databasePath: DATABASE_PATH,
      embedSocketPath: process.env.EMBED_SOCKET,
      embedUrl: process.env.EMBED_URL,
      verbose: false,
    });

    indexingStatus.lastStats = {
      added: stats.added,
      modified: stats.modified,
      deleted: stats.deleted,
      chunks: stats.chunks,
    };
    indexingStatus.progress = "Complete";

    if (stats.errors.length > 0) {
      indexingStatus.lastError = `${stats.errors.length} files had errors`;
    }

    console.log(`Background indexing complete: ${stats.added} added, ${stats.modified} modified, ${stats.chunks} chunks`);
  } catch (err) {
    indexingStatus.lastError = err instanceof Error ? err.message : String(err);
    console.error("Background indexing failed:", err);
  } finally {
    indexingStatus.isIndexing = false;
  }
}

/**
 * Build mapping from database project slugs to archive directory names.
 * Database stores path-based slugs like "-Users-varunr-projects-podcast-summarizer-v2"
 * Archive uses normalized names like "podcast-summarizer-v2"
 */
function buildProjectMapping() {
  projectToArchiveMap.clear();

  // Get archive directories
  const archiveDirs = new Set<string>();
  try {
    const entries = readdirSync(ARCHIVE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        archiveDirs.add(entry.name);
      }
    }
  } catch (err) {
    console.error("Failed to read archive directory:", err);
    return;
  }

  // Get database projects
  const db = getDatabase();
  const projects = db.prepare("SELECT DISTINCT project FROM conversations").all() as { project: string }[];

  // Match each database project to an archive directory
  for (const { project } of projects) {
    // Try direct match first
    if (archiveDirs.has(project)) {
      projectToArchiveMap.set(project, project);
      continue;
    }

    // Convert slug to path segments for matching
    // -Users-varunr-projects-podcast-summarizer-v2 -> potential matches
    const slug = project.replace(/^-/, "");

    // Try to find a matching archive directory
    // Strategy: the archive dir should be a suffix of the slug when hyphens are considered
    let bestMatch: string | undefined;
    let bestMatchLen = 0;

    for (const dir of archiveDirs) {
      // Check if the slug ends with this directory name
      // Account for the hyphen separator: slug should end with -<dir> or be exactly <dir>
      if (slug === dir || slug.endsWith(`-${dir}`)) {
        if (dir.length > bestMatchLen) {
          bestMatch = dir;
          bestMatchLen = dir.length;
        }
      }
    }

    if (bestMatch) {
      projectToArchiveMap.set(project, bestMatch);
    } else {
      // Fallback: use the last hyphen-separated segment
      // This handles edge cases but may not always be correct
      const segments = slug.split("-");
      const lastSegment = segments[segments.length - 1];
      if (lastSegment && archiveDirs.has(lastSegment)) {
        projectToArchiveMap.set(project, lastSegment);
      }
    }
  }

  console.log(`Built project mapping: ${projectToArchiveMap.size} projects mapped to archive directories`);
}

async function initializeSearch() {
  try {
    createDatabase(DATABASE_PATH);
    console.log(`Search database initialized at ${DATABASE_PATH}`);

    // Build project to archive directory mapping
    buildProjectMapping();

    // Try to connect to embedding server (HTTP URL or Unix socket)
    const embedUrl = process.env.EMBED_URL; // e.g., http://localhost:8000
    const socketPath = process.env.EMBED_SOCKET || "/tmp/qwen-embed.sock";

    if (embedUrl) {
      // HTTP endpoint (e.g., qwen3-embeddings-mlx)
      embeddingClient = createEmbeddingClient(embedUrl);
      const healthy = await embeddingClient.isHealthy();
      if (healthy) {
        const info = await embeddingClient.getModelInfo();
        console.log(`Embedding client connected to ${embedUrl} (model: ${info?.model}, dim: ${info?.dim})`);
      } else {
        console.log(`Embedding server at ${embedUrl} not responding - using FTS-only search`);
        embeddingClient = undefined;
      }
    } else if (existsSync(socketPath)) {
      // Unix socket
      embeddingClient = createEmbeddingClient(socketPath);
      console.log(`Embedding client connected to ${socketPath}`);
    } else {
      console.log(`Embedding server not found - using FTS-only search`);
      console.log(`  Set EMBED_URL=http://localhost:8000 for HTTP or EMBED_SOCKET for Unix socket`);
    }
  } catch (err) {
    console.error("Failed to initialize search database:", err);
  }
}

// CSS to inject for progressive disclosure and search bar
const INJECTED_CSS = `
<style id="viewer-enhancements">
/* Dark mode support - follows system preference */
@media (prefers-color-scheme: dark) {
  :root {
    --bg-color: #1a1a2e !important;
    --card-bg: #16213e !important;
    --user-bg: #1e3a5f !important;
    --user-border: #4fc3f7 !important;
    --assistant-bg: #16213e !important;
    --assistant-border: #9e9e9e !important;
    --thinking-bg: #2d2a1e !important;
    --thinking-border: #ffc107 !important;
    --thinking-text: #ccc !important;
    --tool-bg: #2a1f3d !important;
    --tool-border: #ce93d8 !important;
    --tool-result-bg: #1e3d2f !important;
    --tool-error-bg: #3d1e1e !important;
    --text-color: #eee !important;
    --text-muted: #888 !important;
    --code-bg: #0d1117 !important;
    --code-text: #aed581 !important;
    --bg: #1a1a2e;
    --surface: #16213e;
    --primary: #e94560;
    --text: #eee;
    --border: #333;
  }
  body {
    background: var(--bg-color) !important;
    color: var(--text-color) !important;
  }
  .message.user { background: var(--user-bg) !important; }
  .message.assistant { background: var(--card-bg) !important; }
  .index-item { background: var(--card-bg) !important; }
  pre { background: var(--code-bg) !important; }
  code { background: rgba(255,255,255,0.1) !important; }
  .expand-btn, .message-expand-btn {
    background: rgba(255,255,255,0.1) !important;
    color: var(--text-muted) !important;
    border-color: rgba(255,255,255,0.2) !important;
  }
  .pagination a {
    background: var(--card-bg) !important;
    border-color: var(--user-border) !important;
  }
  .pagination .current { background: var(--user-border) !important; }
  /* Fix gradients for dark mode */
  .message-content.collapsed::after,
  .index-item-content.collapsed::after {
    background: linear-gradient(to bottom, transparent, var(--card-bg)) !important;
  }
  .message.user .message-content.collapsed::after {
    background: linear-gradient(to bottom, transparent, var(--user-bg)) !important;
  }
  .truncatable.truncated::after {
    background: linear-gradient(to bottom, transparent, var(--card-bg)) !important;
  }
  .message.user .truncatable.truncated::after {
    background: linear-gradient(to bottom, transparent, var(--user-bg)) !important;
  }
}

/* Global search bar styles */
.viewer-search-bar {
  position: sticky;
  top: 0;
  z-index: 1000;
  background: var(--bg, #1a1a2e);
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border, #333);
  display: flex;
  align-items: center;
  gap: 1rem;
}
.viewer-search-bar a.home-link {
  color: var(--primary, #e94560);
  text-decoration: none;
  font-weight: bold;
  font-size: 0.875rem;
}
.viewer-search-bar a.home-link:hover { text-decoration: underline; }
.viewer-search-bar .search-wrapper {
  position: relative;
  flex: 1;
  max-width: 400px;
}
.viewer-search-bar input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  background: var(--surface, #16213e);
  color: var(--text, #eee);
}
.viewer-search-bar input:focus {
  outline: none;
  border-color: var(--primary, #e94560);
}
.viewer-search-bar .search-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: var(--surface, #16213e);
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  margin-top: 4px;
  display: none;
  max-height: 400px;
  overflow-y: auto;
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
}
.viewer-search-bar .search-dropdown.visible { display: block; }
.viewer-search-bar .search-dropdown-item {
  padding: 0.75rem;
  border-bottom: 1px solid var(--border, #333);
  cursor: pointer;
}
.viewer-search-bar .search-dropdown-item:hover { background: rgba(255,255,255,0.05); }
.viewer-search-bar .search-dropdown-item:last-child { border-bottom: none; }
.viewer-search-bar .search-dropdown-item h4 {
  margin: 0 0 0.25rem 0;
  font-size: 0.875rem;
  color: var(--text, #eee);
}
.viewer-search-bar .search-dropdown-item p {
  margin: 0;
  font-size: 0.75rem;
  color: var(--text-muted, #888);
}
.viewer-search-bar .search-dropdown-item p strong { color: var(--primary, #e94560); }

/* Filter toggle buttons */
.filter-toggles {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.filter-btn {
  padding: 0.35rem 0.6rem;
  font-size: 0.75rem;
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted, #888);
  cursor: pointer;
  opacity: 0.5;
  transition: all 0.15s ease;
}
.filter-btn:hover {
  opacity: 0.8;
  border-color: var(--primary, #e94560);
}
.filter-btn.active {
  opacity: 1;
  background: var(--surface, #16213e);
  border-color: var(--primary, #e94560);
  color: var(--text, #eee);
}

/* Filter visibility - elements get .filter-hidden class from JS */
.filter-hidden { display: none !important; }

/* Assistant text wrapper (dynamically added) */
.assistant-text { display: block; }

/* Insight blocks */
.insight-block {
  border-left: 3px solid #ffd700;
  padding-left: 0.5rem;
  margin: 0.5rem 0;
}

/* Performance optimization - removed content-visibility from .message to allow proper collapse sizing */
.cell {
  content-visibility: auto;
  contain: layout style paint;
  contain-intrinsic-size: 1px 400px;
}

/* Content collapsing - line-based (messages and index items) */
.message-content.collapsed,
.index-item-content.collapsed {
  --collapse-lines: 10;
  --line-height: 1.5em;
  max-height: calc(var(--collapse-lines) * var(--line-height));
  overflow: hidden;
  position: relative;
}
.message-content.collapsed::after,
.index-item-content.collapsed::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 3em;
  background: linear-gradient(to bottom, transparent, var(--card-bg, #fff));
  pointer-events: none;
}
.message.user .message-content.collapsed::after {
  background: linear-gradient(to bottom, transparent, var(--user-bg, #e3f2fd));
}
.message.tool-reply .message-content.collapsed::after {
  background: linear-gradient(to bottom, transparent, #fff8e1);
}
.message-expand-btn {
  display: block;
  width: 100%;
  padding: 8px;
  margin-top: 4px;
  background: rgba(0,0,0,0.05);
  border: 1px solid rgba(0,0,0,0.1);
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.85rem;
  color: var(--text-muted, #757575);
  text-align: center;
}
.message-expand-btn:hover { background: rgba(0,0,0,0.1); }

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

// JavaScript for infinite scroll and search bar
const INJECTED_JS = `
<script id="viewer-enhancements-js">
(function() {
  // Collapse long content - line-based collapsing
  // Applies to both message pages (.message-content) and index pages (.index-item-content)
  const MAX_LINES = 10;
  const MIN_HIDDEN_LINES = 5; // Only collapse if hiding at least this many lines

  function collapseContent(root) {
    const container = root || document;
    // Target both message content and index item content
    container.querySelectorAll('.message-content, .index-item-content').forEach(function(content) {
      // Skip if already processed or has truncatable handling
      if (content.dataset.collapseProcessed) return;
      if (content.closest('.truncatable')) return;
      content.dataset.collapseProcessed = 'true';

      // Calculate line height and total lines
      const style = window.getComputedStyle(content);
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
      const totalHeight = content.scrollHeight;
      const totalLines = Math.ceil(totalHeight / lineHeight);
      const hiddenLines = totalLines - MAX_LINES;

      if (hiddenLines >= MIN_HIDDEN_LINES) {
        content.classList.add('collapsed');
        content.style.setProperty('--line-height', lineHeight + 'px');

        const btn = document.createElement('button');
        btn.className = 'message-expand-btn';
        btn.textContent = 'Show ' + hiddenLines + ' more lines';
        btn.addEventListener('click', function() {
          if (content.classList.contains('collapsed')) {
            content.classList.remove('collapsed');
            btn.textContent = 'Show less';
          } else {
            content.classList.add('collapsed');
            btn.textContent = 'Show ' + hiddenLines + ' more lines';
          }
        });
        content.parentNode.insertBefore(btn, content.nextSibling);
      }
    });
  }

  // Initial collapse
  collapseContent();

  // Export for use by infinite scroll
  window.collapseContent = collapseContent;

  // Infinite scroll state - use window to persist across any script re-execution
  if (typeof window.__infiniteScrollState === 'undefined') {
    const pageMatch = window.location.pathname.match(/page-([0-9]+)\\.html/);
    window.__infiniteScrollState = {
      currentPage: pageMatch ? parseInt(pageMatch[1], 10) : 1,
      totalPages: 1,
      isLoading: false
    };
  }
  const state = window.__infiniteScrollState;

  // Detect total pages from pagination
  function detectTotalPages() {
    const pagination = document.querySelector('.pagination');
    if (pagination) {
      const links = pagination.querySelectorAll('a[href^="page-"]');
      links.forEach(link => {
        const match = link.href.match(/page-([0-9]+)\\.html/);
        if (match) {
          const pageNum = parseInt(match[1], 10);
          if (pageNum > state.totalPages) state.totalPages = pageNum;
        }
      });
    }
  }

  // Load next page content
  async function loadNextPage() {
    // Set isLoading and increment currentPage IMMEDIATELY to prevent race conditions
    if (state.isLoading || state.currentPage >= state.totalPages) {
      return;
    }
    state.isLoading = true;
    state.currentPage++;  // Increment synchronously BEFORE any async work

    const pageToLoad = state.currentPage;
    const loader = document.getElementById('infinite-scroll-loader');
    if (loader) loader.className = 'loading';

    const nextUrl = window.location.pathname.replace(
      /page-[0-9]+\\.html/,
      'page-' + String(pageToLoad).padStart(3, '0') + '.html'
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
      const loader = document.getElementById('infinite-scroll-loader');

      if (container && messages.length > 0) {
        messages.forEach(msg => {
          const clone = document.importNode(msg, true);
          // Always insert before loader to maintain correct order
          container.insertBefore(clone, loader);
        });

        // Collapse newly loaded messages
        if (window.collapseContent) {
          window.collapseContent();
        }

        // Apply filters to newly loaded content (order: wrap, then extract insights)
        if (window.wrapAssistantText) window.wrapAssistantText();
        if (window.markInsightBlocks) window.markInsightBlocks();
        if (window.applyFilters) window.applyFilters();
      }
    } catch (err) {
      console.error('Failed to load page', pageToLoad, ':', err);
      // Rollback on error
      state.currentPage--;
    } finally {
      state.isLoading = false;
      const loader = document.getElementById('infinite-scroll-loader');
      if (loader) {
        loader.className = state.currentPage >= state.totalPages ? 'done' : '';
      }
    }
  }

  // Set up infinite scroll observer
  function setupInfiniteScroll() {
    // Check if already set up by looking for the loader element (most reliable guard)
    if (document.getElementById('infinite-scroll-loader')) {
      return;  // Already set up
    }

    const container = document.querySelector('.container');
    const paginations = document.querySelectorAll('.pagination');

    if (container) {
      // Hide ALL pagination elements
      paginations.forEach(p => p.style.display = 'none');

      const loader = document.createElement('div');
      loader.id = 'infinite-scroll-loader';
      container.appendChild(loader);

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
    setupInfiniteScroll();
    setupSearchBar();
    setupFilters();
  }

  // Filter toggle functionality
  function setupFilters() {
    const filterContainer = document.getElementById('filter-toggles');
    if (!filterContainer) return;

    // Order matters: wrap first, then extract insights
    // 1. Wrap assistant text (excluding thinking, tool-use - insights handled after)
    wrapAssistantText();

    // 2. Extract insight blocks from assistant-text and move them out
    markInsightBlocks();

    filterContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('.filter-btn');
      if (!btn) return;

      btn.classList.toggle('active');
      applyFilters();
    });
  }

  // Extract insight blocks from assistant-text and wrap them properly
  function markInsightBlocks() {
    document.querySelectorAll('.message.assistant .message-content').forEach(content => {
      if (content.dataset.insightProcessed) return;
      content.dataset.insightProcessed = 'true';

      // Find all code/pre elements that contain insight markers
      const insightStarts = Array.from(content.querySelectorAll('code, pre')).filter(el => {
        if (!el.textContent.includes('★ Insight')) return false;
        // Skip if already inside an insight-block
        if (el.closest('.insight-block')) return false;
        return true;
      });

      insightStarts.forEach(startEl => {
        // Find the container we need to work within (either assistant-text or message-content)
        const assistantText = startEl.closest('.assistant-text');
        const container = assistantText || content;

        // Find the parent block element (usually a <p> tag) that is a direct child of container
        let startBlock = startEl;
        while (startBlock.parentElement && startBlock.parentElement !== container) {
          startBlock = startBlock.parentElement;
        }

        // If startBlock is not a direct child of container, skip
        if (startBlock.parentElement !== container) return;

        // Collect all sibling elements until we find the closing dashes
        const elementsToWrap = [startBlock];
        let current = startBlock.nextElementSibling;

        while (current) {
          elementsToWrap.push(current);

          // Check if this element contains the closing dashes (────)
          const hasClosingDashes = current.textContent && current.textContent.includes('────') &&
            !current.textContent.includes('★ Insight');

          if (hasClosingDashes) {
            break;
          }
          current = current.nextElementSibling;
        }

        // Create the insight wrapper
        if (elementsToWrap.length > 0) {
          const wrapper = document.createElement('div');
          wrapper.className = 'insight-block';

          // Insert wrapper before the first element in the container
          container.insertBefore(wrapper, startBlock);

          // Move all elements into the wrapper
          elementsToWrap.forEach(el => wrapper.appendChild(el));

          // If we extracted from assistant-text, move the wrapper to message-content level
          if (assistantText && content !== assistantText) {
            // Insert the insight wrapper after assistant-text in message-content
            content.insertBefore(wrapper, assistantText.nextSibling);
          }
        }
      });
    });
  }

  // Wrap non-special content in assistant messages
  function wrapAssistantText() {
    document.querySelectorAll('.message.assistant .message-content').forEach(content => {
      if (content.querySelector(':scope > .assistant-text')) return; // Already wrapped at this level

      const children = [...content.childNodes];
      const wrapper = document.createElement('div');
      wrapper.className = 'assistant-text';

      children.forEach(child => {
        // Skip special blocks - they stay outside the wrapper
        if (child.nodeType === 1) { // Element node
          const el = child;
          if (el.classList.contains('thinking') ||
              el.classList.contains('tool-use') ||
              el.classList.contains('insight-block')) {
            return;
          }
        }
        // Move to wrapper
        wrapper.appendChild(child);
      });

      // Insert wrapper at the beginning
      if (wrapper.childNodes.length > 0) {
        content.insertBefore(wrapper, content.firstChild);
      }
    });
  }

  // Apply current filter state
  function applyFilters() {
    const filters = {};
    document.querySelectorAll('.filter-btn').forEach(btn => {
      filters[btn.dataset.filter] = btn.classList.contains('active');
    });

    // Apply to user messages
    document.querySelectorAll('.message.user').forEach(el => {
      el.classList.toggle('filter-hidden', !filters.user);
    });

    // Apply to tool results
    document.querySelectorAll('.message.tool-reply').forEach(el => {
      el.classList.toggle('filter-hidden', !filters['tool-reply']);
    });

    // Apply to thinking blocks
    document.querySelectorAll('.thinking').forEach(el => {
      el.classList.toggle('filter-hidden', !filters.thinking);
    });

    // Apply to tool-use blocks
    document.querySelectorAll('.tool-use').forEach(el => {
      el.classList.toggle('filter-hidden', !filters['tool-use']);
    });

    // Apply to insight blocks
    document.querySelectorAll('.insight-block').forEach(el => {
      el.classList.toggle('filter-hidden', !filters.insight);
    });

    // Apply to assistant text
    document.querySelectorAll('.assistant-text').forEach(el => {
      el.classList.toggle('filter-hidden', !filters.assistant);
    });

    // Hide assistant messages that are now empty
    document.querySelectorAll('.message.assistant').forEach(msg => {
      const content = msg.querySelector('.message-content');
      if (!content) return;

      // Check if any visible filterable content remains
      const hasVisibleThinking = filters.thinking && content.querySelector('.thinking:not(.filter-hidden)');
      const hasVisibleToolUse = filters['tool-use'] && content.querySelector('.tool-use:not(.filter-hidden)');
      const hasVisibleInsight = filters.insight && content.querySelector('.insight-block:not(.filter-hidden)');

      // For assistant text, also check it has meaningful content (not just whitespace)
      let hasVisibleText = false;
      if (filters.assistant) {
        const assistantText = content.querySelector('.assistant-text:not(.filter-hidden)');
        if (assistantText && assistantText.textContent.trim().length > 0) {
          hasVisibleText = true;
        }
      }

      const hasVisibleContent = hasVisibleThinking || hasVisibleToolUse || hasVisibleInsight || hasVisibleText;

      msg.classList.toggle('filter-hidden', !hasVisibleContent);
    });
  }

  // Re-apply filters when new content is loaded (infinite scroll)
  window.applyFilters = applyFilters;
  window.markInsightBlocks = markInsightBlocks;
  window.wrapAssistantText = wrapAssistantText;

  // Search bar functionality
  function setupSearchBar() {
    const searchInput = document.getElementById('viewer-search-input');
    const dropdown = document.getElementById('viewer-search-dropdown');
    if (!searchInput || !dropdown) return;

    let debounceTimer;

    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      const q = searchInput.value.trim();
      if (!q) {
        dropdown.classList.remove('visible');
        return;
      }
      debounceTimer = setTimeout(() => performSearch(q), 200);
    });

    // Handle Enter key to go to full search page
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = searchInput.value.trim();
        if (q) {
          window.location.href = '/search?q=' + encodeURIComponent(q);
        }
      }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.viewer-search-bar')) {
        dropdown.classList.remove('visible');
      }
    });

    async function performSearch(q) {
      try {
        const res = await fetch('/api/search?q=' + encodeURIComponent(q) + '&limit=5');
        const data = await res.json();

        dropdown.textContent = '';

        if (data.results && data.results.length > 0) {
          data.results.forEach(r => {
            const item = document.createElement('div');
            item.className = 'search-dropdown-item';
            item.onclick = () => window.location.href = r.url;

            const title = document.createElement('h4');
            title.textContent = (r.title || 'Untitled').slice(0, 50);
            item.appendChild(title);

            const snippet = document.createElement('p');
            // Safe: server escapes content before adding <strong> tags
            snippet.innerHTML = r.snippet;
            item.appendChild(snippet);

            dropdown.appendChild(item);
          });

          // Add "view all" link
          const viewAll = document.createElement('div');
          viewAll.className = 'search-dropdown-item';
          viewAll.onclick = () => window.location.href = '/search?q=' + encodeURIComponent(q);
          const em = document.createElement('em');
          em.textContent = 'View all results...';
          em.style.color = 'var(--primary, #e94560)';
          viewAll.appendChild(em);
          dropdown.appendChild(viewAll);

          dropdown.classList.add('visible');
        } else {
          const noResults = document.createElement('div');
          noResults.className = 'search-dropdown-item';
          const em = document.createElement('em');
          em.textContent = 'No results found';
          noResults.appendChild(em);
          dropdown.appendChild(noResults);
          dropdown.classList.add('visible');
        }
      } catch (err) {
        console.error('Search failed:', err);
      }
    }
  }
})();
</script>
`;

// Search bar HTML to inject at top of body
const SEARCH_BAR_HTML = `
<div class="viewer-search-bar">
  <a href="/" class="home-link">← Home</a>
  <div class="search-wrapper">
    <input type="search" id="viewer-search-input" placeholder="Search all conversations..." autocomplete="off" />
    <div id="viewer-search-dropdown" class="search-dropdown"></div>
  </div>
  <div class="filter-toggles" id="filter-toggles">
    <button class="filter-btn active" data-filter="user" title="User messages">👤 User</button>
    <button class="filter-btn active" data-filter="assistant" title="Assistant text">🤖 Assistant</button>
    <button class="filter-btn active" data-filter="tool-use" title="Tool calls">🔧 Tools</button>
    <button class="filter-btn active" data-filter="tool-reply" title="Tool results">📋 Results</button>
    <button class="filter-btn active" data-filter="thinking" title="Thinking blocks">💭 Thinking</button>
    <button class="filter-btn active" data-filter="insight" title="Insight blocks">★ Insight</button>
  </div>
</div>
`;

// Inject enhancements into HTML
function enhanceHtml(html: string): string {
  const $ = cheerio.load(html);

  // Inject CSS before </head>
  $("head").append(INJECTED_CSS);

  // Inject search bar at beginning of body
  $("body").prepend(SEARCH_BAR_HTML);

  // Inject JS before </body>
  $("body").append(INJECTED_JS);

  return $.html();
}

// Serve enhanced HTML files
// Redirect session index.html to page-001.html for direct navigation
app.get(/.*\.html$/, (req: Request, res: Response) => {
  // Redirect session index.html to page-001.html
  // Pattern: /project/uuid/index.html -> /project/uuid/page-001.html
  const sessionIndexMatch = req.path.match(/^\/([^/]+)\/([a-f0-9-]{36})\/index\.html$/);
  if (sessionIndexMatch) {
    const [, project, session] = sessionIndexMatch;
    return res.redirect(`/${project}/${session}/page-001.html`);
  }

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

// Serve static assets (CSS, JS, images) - disable index.html serving so our dynamic routes work
app.use(express.static(ARCHIVE_DIR, { index: false }));

// Serve project directory index.html files (since we disabled automatic index serving)
// Rewrite session links to go directly to page-001.html instead of session index.html
app.get("/:project/", (req: Request, res: Response) => {
  const project = req.params.project as string;
  const projectDir = join(ARCHIVE_DIR, project);
  const indexPath = resolve(projectDir, "index.html");

  if (existsSync(indexPath)) {
    try {
      let html = readFileSync(indexPath, "utf-8");
      // Rewrite session links: href="uuid/index.html" -> href="uuid/page-001.html"
      html = html.replace(/href="([a-f0-9-]{36})\/index\.html"/g, 'href="$1/page-001.html"');
      // Inject our enhancements (dark mode, etc.)
      html = enhanceHtml(html);
      res.type("html").send(html);
    } catch (err) {
      console.error("Error serving project index:", err);
      res.status(500).send("Error serving file");
    }
  } else {
    res.status(404).send("Project not found");
  }
});

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

// Search API endpoint
app.get("/api/search", async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    const query = (req.query.q as string) || "";
    const options: SearchOptions = {
      project: req.query.project as string | undefined,
      role: req.query.role as "user" | "assistant" | undefined,
      after: req.query.after as string | undefined,
      before: req.query.before as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 20,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : 0,
    };

    const result = await searchHybrid(query, options, embeddingClient);

    // Format response according to design spec
    if (result.type === "recent") {
      res.json({
        type: "recent",
        conversations: result.conversations,
        query_time_ms: Date.now() - startTime,
      });
      return;
    }

    // Add snippets with highlighting to results
    const resultsWithSnippets = (result.results || []).map((r) => {
      const terms = query.split(/\s+/).filter(Boolean);
      const snippet = generateSnippet(r.content, query, 100);
      const highlightedSnippet = highlightTerms(snippet, terms);

      return {
        chunk_id: r.chunk_id,
        conversation_id: r.conversation_id,
        project: r.project,
        title: r.title,
        snippet: highlightedSnippet,
        role: r.role,
        page: r.page_number,
        score: r.score,
        url: `/${projectToArchivePath(r.project)}/${r.conversation_id}/page-001.html`,
      };
    });

    res.json({
      type: result.type,
      results: resultsWithSnippets,
      total: resultsWithSnippets.length,
      query_time_ms: Date.now() - startTime,
      embedding_status: result.embeddingStatus,
    });
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

// Index status endpoint
app.get("/api/index/status", (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const chunkCount = db.prepare("SELECT COUNT(*) as count FROM chunks").get() as { count: number };
    const convCount = db.prepare("SELECT COUNT(*) as count FROM conversations").get() as { count: number };

    const overallStatus = archiveStatus.isGenerating
      ? "generating"
      : indexingStatus.isIndexing
        ? "indexing"
        : "ready";

    res.json({
      status: overallStatus,
      conversations: convCount.count,
      chunks: chunkCount.count,
      embedding_server: embeddingClient ? "connected" : "unavailable",
      archive: {
        isGenerating: archiveStatus.isGenerating,
        progress: archiveStatus.progress,
        lastError: archiveStatus.lastError,
        lastRun: archiveStatus.lastRun,
      },
      indexing: {
        isIndexing: indexingStatus.isIndexing,
        progress: indexingStatus.progress,
        lastError: indexingStatus.lastError,
        lastStats: indexingStatus.lastStats,
      },
    });
  } catch (err) {
    res.json({
      status: "not_initialized",
      conversations: 0,
      chunks: 0,
      embedding_server: "unavailable",
      archive: archiveStatus,
      indexing: indexingStatus,
    });
  }
});

// Manually trigger archive regeneration
app.post("/api/archive/regenerate", async (req: Request, res: Response) => {
  if (archiveStatus.isGenerating) {
    res.status(409).json({ error: "Archive generation already in progress" });
    return;
  }

  if (!SOURCE_DIR) {
    res.status(400).json({ error: "No SOURCE_DIR configured" });
    return;
  }

  // Start archive generation in background, then index
  (async () => {
    await generateArchive();
    await startBackgroundIndexing();
  })();

  res.json({ status: "started", message: "Archive generation started in background" });
});

// Manually trigger re-indexing
app.post("/api/index/reindex", async (req: Request, res: Response) => {
  if (indexingStatus.isIndexing) {
    res.status(409).json({ error: "Indexing already in progress" });
    return;
  }

  if (!SOURCE_DIR) {
    res.status(400).json({ error: "No SOURCE_DIR configured" });
    return;
  }

  // Start indexing in background
  startBackgroundIndexing();

  res.json({ status: "started", message: "Indexing started in background" });
});

// Search results page
app.get("/search", async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    const query = (req.query.q as string) || "";
    const options: SearchOptions = {
      project: req.query.project as string | undefined,
      role: req.query.role as "user" | "assistant" | undefined,
      after: req.query.after as string | undefined,
      before: req.query.before as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 50,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : 0,
    };

    const db = getDatabase();

    // Get list of projects for filter dropdown
    const projects = db.prepare(`
      SELECT DISTINCT project FROM conversations ORDER BY project
    `).all() as Array<{ project: string }>;

    let results: Array<{
      chunk_id: number;
      conversation_id: string;
      project: string;
      title: string;
      snippet: string;
      role: string;
      page: number;
      score: number;
      url: string;
    }> = [];

    if (query) {
      const searchResult = await searchHybrid(query, options, embeddingClient);

      results = (searchResult.results || []).map((r) => {
        const terms = query.split(/\s+/).filter(Boolean);
        const snippet = generateSnippet(r.content, query, 150);
        const highlightedSnippet = highlightTerms(snippet, terms);

        return {
          chunk_id: r.chunk_id,
          conversation_id: r.conversation_id,
          project: r.project,
          title: r.title || "Untitled",
          snippet: highlightedSnippet,
          role: r.role,
          page: r.page_number || 1,
          score: r.score,
          url: `/${projectToArchivePath(r.project)}/${r.conversation_id}/page-001.html`,
        };
      });
    }

    const html = renderSearchPage({
      query,
      results,
      projects: projects.map((p) => p.project),
      filters: {
        project: options.project,
        role: options.role,
        after: options.after,
        before: options.before,
      },
      queryTimeMs: Date.now() - startTime,
      offset: options.offset || 0,
      limit: options.limit || 50,
    });

    res.type("html").send(html);
  } catch (err) {
    console.error("Search page error:", err);
    res.status(500).send("Search failed");
  }
});

function renderSearchPage(data: {
  query: string;
  results: Array<{
    chunk_id: number;
    conversation_id: string;
    project: string;
    title: string;
    snippet: string;
    role: string;
    page: number;
    score: number;
    url: string;
  }>;
  projects: string[];
  filters: {
    project?: string;
    role?: string;
    after?: string;
    before?: string;
  };
  queryTimeMs: number;
  offset: number;
  limit: number;
}): string {
  const projectOptions = data.projects
    .map(
      (p) =>
        `<option value="${escapeHtml(p)}"${data.filters.project === p ? " selected" : ""}>${escapeHtml(p)}</option>`
    )
    .join("");

  const resultItems = data.results
    .map(
      (r) => `
      <div class="search-result-item">
        <a href="${escapeHtml(r.url)}">
          <h3>${escapeHtml(r.title?.slice(0, 80) || "Untitled")}${r.title && r.title.length > 80 ? "..." : ""}</h3>
          <div class="result-meta">
            <span class="project">${escapeHtml(r.project)}</span>
            <span class="role ${r.role}">${escapeHtml(r.role)}</span>
          </div>
          <p class="result-snippet">${r.snippet}</p>
        </a>
      </div>
    `
    )
    .join("");

  const hasMore = data.results.length === data.limit;
  const prevOffset = Math.max(0, data.offset - data.limit);
  const nextOffset = data.offset + data.limit;

  const buildUrl = (offset: number) => {
    const params = new URLSearchParams();
    if (data.query) params.set("q", data.query);
    if (data.filters.project) params.set("project", data.filters.project);
    if (data.filters.role) params.set("role", data.filters.role);
    if (data.filters.after) params.set("after", data.filters.after);
    if (data.filters.before) params.set("before", data.filters.before);
    if (offset > 0) params.set("offset", String(offset));
    return `/search?${params.toString()}`;
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${data.query ? escapeHtml(data.query) + " - " : ""}Search - Claude Transcript Viewer</title>
  <style>
    :root {
      --bg: #1a1a2e;
      --surface: #16213e;
      --primary: #e94560;
      --text: #eee;
      --text-muted: #888;
      --border: #333;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
    }
    .header {
      background: var(--surface);
      padding: 1rem 2rem;
      border-bottom: 1px solid var(--border);
    }
    .header a { color: var(--primary); text-decoration: none; }
    .header a:hover { text-decoration: underline; }
    .search-form {
      max-width: 1200px;
      margin: 2rem auto;
      padding: 0 2rem;
    }
    .search-row {
      display: flex;
      gap: 1rem;
      margin-bottom: 1rem;
    }
    .search-row input[type="search"] {
      flex: 1;
      padding: 0.75rem 1rem;
      font-size: 1rem;
      border: 2px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      color: var(--text);
    }
    .search-row input[type="search"]:focus {
      outline: none;
      border-color: var(--primary);
    }
    .search-row button {
      padding: 0.75rem 1.5rem;
      font-size: 1rem;
      border: none;
      border-radius: 8px;
      background: var(--primary);
      color: #fff;
      cursor: pointer;
    }
    .search-row button:hover { opacity: 0.9; }
    .filters {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
    }
    .filters select, .filters input {
      padding: 0.5rem;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--surface);
      color: var(--text);
      font-size: 0.875rem;
    }
    .filters label {
      color: var(--text-muted);
      font-size: 0.75rem;
      display: block;
      margin-bottom: 0.25rem;
    }
    .results-container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 0 2rem 2rem;
    }
    .results-info {
      color: var(--text-muted);
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }
    .search-result-item {
      background: var(--surface);
      border-radius: 8px;
      margin-bottom: 1rem;
      transition: transform 0.2s;
    }
    .search-result-item:hover {
      transform: translateX(4px);
    }
    .search-result-item a {
      display: block;
      padding: 1rem 1.5rem;
      text-decoration: none;
      color: inherit;
    }
    .search-result-item h3 {
      margin-bottom: 0.5rem;
      color: var(--text);
    }
    .result-meta {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }
    .result-meta span {
      font-size: 0.75rem;
      padding: 0.125rem 0.5rem;
      border-radius: 4px;
    }
    .result-meta .project {
      background: rgba(233, 69, 96, 0.2);
      color: var(--primary);
    }
    .result-meta .role {
      background: rgba(255, 255, 255, 0.1);
      color: var(--text-muted);
    }
    .result-meta .role.user { color: #64b5f6; }
    .result-meta .role.assistant { color: #81c784; }
    .result-snippet {
      color: var(--text-muted);
      font-size: 0.875rem;
    }
    .result-snippet strong {
      color: var(--primary);
      font-weight: normal;
      background: rgba(233, 69, 96, 0.2);
      padding: 0 2px;
      border-radius: 2px;
    }
    .pagination {
      display: flex;
      justify-content: center;
      gap: 1rem;
      margin-top: 2rem;
    }
    .pagination a {
      padding: 0.5rem 1rem;
      background: var(--surface);
      color: var(--text);
      text-decoration: none;
      border-radius: 4px;
    }
    .pagination a:hover { background: rgba(255,255,255,0.1); }
    .pagination a.disabled {
      opacity: 0.5;
      pointer-events: none;
    }
    .no-results {
      text-align: center;
      padding: 3rem;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="header">
    <a href="/">← Back to Home</a>
  </div>

  <form class="search-form" method="GET" action="/search">
    <div class="search-row">
      <input type="search" name="q" value="${escapeHtml(data.query)}" placeholder="Search conversations..." autofocus />
      <button type="submit">Search</button>
    </div>
    <div class="filters">
      <div>
        <label>Project</label>
        <select name="project">
          <option value="">All projects</option>
          ${projectOptions}
        </select>
      </div>
      <div>
        <label>Role</label>
        <select name="role">
          <option value="">All roles</option>
          <option value="user"${data.filters.role === "user" ? " selected" : ""}>User</option>
          <option value="assistant"${data.filters.role === "assistant" ? " selected" : ""}>Assistant</option>
        </select>
      </div>
      <div>
        <label>After</label>
        <input type="date" name="after" value="${escapeHtml(data.filters.after || "")}" />
      </div>
      <div>
        <label>Before</label>
        <input type="date" name="before" value="${escapeHtml(data.filters.before || "")}" />
      </div>
    </div>
  </form>

  <div class="results-container">
    ${
      data.query
        ? `<p class="results-info">${data.results.length} results for "${escapeHtml(data.query)}" (${data.queryTimeMs}ms)</p>`
        : `<p class="results-info">Enter a search query above</p>`
    }

    ${
      data.results.length > 0
        ? resultItems
        : data.query
          ? `<div class="no-results"><p>No results found for "${escapeHtml(data.query)}"</p></div>`
          : ""
    }

    ${
      data.query && (data.offset > 0 || hasMore)
        ? `
      <div class="pagination">
        <a href="${buildUrl(prevOffset)}" class="${data.offset === 0 ? "disabled" : ""}">← Previous</a>
        <a href="${buildUrl(nextOffset)}" class="${!hasMore ? "disabled" : ""}">Next →</a>
      </div>
    `
        : ""
    }
  </div>
</body>
</html>`;
}

// Landing page
app.get("/", async (req: Request, res: Response) => {
  try {
    const db = getDatabase();

    // Get project stats
    const projects = db.prepare(`
      SELECT project, COUNT(*) as count, MAX(created_at) as last_updated
      FROM conversations
      GROUP BY project
      ORDER BY last_updated DESC
    `).all() as Array<{ project: string; count: number; last_updated: string }>;

    // Get recent conversations
    const recentConversations = db.prepare(`
      SELECT id, project, title, created_at
      FROM conversations
      ORDER BY created_at DESC
      LIMIT 10
    `).all() as Array<{ id: string; project: string; title: string; created_at: string }>;

    // Get index stats
    const chunkCount = db.prepare("SELECT COUNT(*) as count FROM chunks").get() as { count: number };

    const html = renderLandingPage({
      projects,
      recentConversations,
      chunkCount: chunkCount.count,
      embeddingStatus: embeddingClient ? "connected" : "unavailable",
    });

    res.type("html").send(html);
  } catch (err) {
    // Database not initialized - show setup instructions
    res.type("html").send(renderSetupPage());
  }
});

function renderLandingPage(data: {
  projects: Array<{ project: string; count: number; last_updated: string }>;
  recentConversations: Array<{ id: string; project: string; title: string; created_at: string }>;
  chunkCount: number;
  embeddingStatus: string;
}): string {
  const projectCards = data.projects
    .map((p) => {
      const archiveName = projectToArchivePath(p.project);
      return `
      <a href="/${escapeHtml(archiveName)}/" class="project-card">
        <h3>${escapeHtml(archiveName)}</h3>
        <p>${p.count} conversations</p>
        <small>Updated: ${new Date(p.last_updated).toLocaleDateString()}</small>
      </a>
    `;
    })
    .join("");

  const recentList = data.recentConversations
    .map((c) => {
      const archiveName = projectToArchivePath(c.project);
      return `
      <li>
        <a href="/${escapeHtml(archiveName)}/${escapeHtml(c.id)}/page-001.html">
          <strong>${escapeHtml(c.title?.slice(0, 60) || "Untitled")}${c.title && c.title.length > 60 ? "..." : ""}</strong>
          <span class="meta">${escapeHtml(archiveName)} - ${new Date(c.created_at).toLocaleDateString()}</span>
        </a>
      </li>
    `;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Transcript Viewer</title>
  <style>
    :root {
      --bg: #1a1a2e;
      --surface: #16213e;
      --primary: #e94560;
      --text: #eee;
      --text-muted: #888;
      --border: #333;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 2rem;
      max-width: 1200px;
      margin: 0 auto;
    }
    h1 { margin-bottom: 0.5rem; }
    .status {
      color: var(--text-muted);
      font-size: 0.875rem;
      margin-bottom: 2rem;
    }
    .status .dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 4px;
    }
    .status .dot.green { background: #4caf50; }
    .status .dot.yellow { background: #ff9800; }
    .search-container {
      margin-bottom: 2rem;
    }
    #search-input {
      width: 100%;
      padding: 1rem;
      font-size: 1.1rem;
      border: 2px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      color: var(--text);
    }
    #search-input:focus {
      outline: none;
      border-color: var(--primary);
    }
    #search-results {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-top: 0.5rem;
      display: none;
    }
    #search-results.visible { display: block; }
    .search-result {
      padding: 1rem;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
    }
    .search-result:hover { background: rgba(255,255,255,0.05); }
    .search-result:last-child { border-bottom: none; }
    .search-result h4 { margin-bottom: 0.25rem; }
    .search-result .snippet { color: var(--text-muted); font-size: 0.875rem; }
    .search-result .snippet strong { color: var(--primary); }
    h2 { margin: 2rem 0 1rem; color: var(--text-muted); font-size: 0.875rem; text-transform: uppercase; }
    .projects {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .project-card {
      background: var(--surface);
      padding: 1.5rem;
      border-radius: 8px;
      text-decoration: none;
      color: var(--text);
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .project-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .project-card h3 { margin-bottom: 0.5rem; }
    .project-card p { color: var(--text-muted); }
    .project-card small { color: var(--text-muted); font-size: 0.75rem; }
    .recent-list {
      list-style: none;
    }
    .recent-list li {
      margin-bottom: 0.75rem;
    }
    .recent-list a {
      display: block;
      padding: 1rem;
      background: var(--surface);
      border-radius: 8px;
      text-decoration: none;
      color: var(--text);
    }
    .recent-list a:hover { background: rgba(255,255,255,0.05); }
    .recent-list .meta {
      display: block;
      color: var(--text-muted);
      font-size: 0.75rem;
      margin-top: 0.25rem;
    }
  </style>
</head>
<body>
  <h1>Claude Transcript Viewer</h1>
  <p class="status">
    <span class="dot green"></span> ${data.chunkCount.toLocaleString()} chunks indexed
    <span style="margin-left: 1rem;">
      <span class="dot ${data.embeddingStatus === "connected" ? "green" : "yellow"}"></span>
      Embeddings: ${data.embeddingStatus}
    </span>
  </p>

  <div class="search-container">
    <input type="search" id="search-input" placeholder="Search conversations..." autocomplete="off" />
    <div id="search-results"></div>
  </div>

  <h2>Projects</h2>
  <div class="projects">
    ${projectCards || "<p>No projects indexed yet.</p>"}
  </div>

  <h2>Recent Conversations</h2>
  <ul class="recent-list">
    ${recentList || "<li>No conversations indexed yet.</li>"}
  </ul>

  <script>
    const input = document.getElementById('search-input');
    const resultsContainer = document.getElementById('search-results');
    let debounceTimer;

    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      const q = input.value.trim();
      if (!q) {
        resultsContainer.classList.remove('visible');
        return;
      }
      debounceTimer = setTimeout(() => search(q), 200);
    });

    async function search(q) {
      try {
        const res = await fetch('/api/search?q=' + encodeURIComponent(q) + '&limit=5');
        const data = await res.json();

        // Clear previous results using safe DOM manipulation
        resultsContainer.textContent = '';

        if (data.results && data.results.length > 0) {
          data.results.forEach(r => {
            const div = document.createElement('div');
            div.className = 'search-result';
            div.onclick = () => window.location.href = r.url;

            const title = document.createElement('h4');
            title.textContent = r.title || 'Untitled';
            div.appendChild(title);

            const snippet = document.createElement('p');
            snippet.className = 'snippet';
            // Safe: server escapes content before adding <strong> tags
            snippet.innerHTML = r.snippet;
            div.appendChild(snippet);

            resultsContainer.appendChild(div);
          });

          // Add "view all" link
          const viewAll = document.createElement('div');
          viewAll.className = 'search-result';
          viewAll.onclick = () => window.location.href = '/search?q=' + encodeURIComponent(q);
          const em = document.createElement('em');
          em.textContent = 'View all results for "' + q + '"';
          viewAll.appendChild(em);
          resultsContainer.appendChild(viewAll);

          resultsContainer.classList.add('visible');
        } else {
          const noResults = document.createElement('div');
          noResults.className = 'search-result';
          const em = document.createElement('em');
          em.textContent = 'No results found';
          noResults.appendChild(em);
          resultsContainer.appendChild(noResults);
          resultsContainer.classList.add('visible');
        }
      } catch (err) {
        console.error('Search failed:', err);
      }
    }
  </script>
</body>
</html>`;
}

function renderSetupPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Claude Transcript Viewer - Setup</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      background: #1a1a2e;
      color: #eee;
      padding: 2rem;
      max-width: 800px;
      margin: 0 auto;
    }
    h1 { margin-bottom: 1rem; }
    pre {
      background: #16213e;
      padding: 1rem;
      border-radius: 8px;
      overflow-x: auto;
    }
    code { color: #e94560; }
  </style>
</head>
<body>
  <h1>Welcome to Claude Transcript Viewer</h1>
  <p>To get started, index your transcripts:</p>
  <pre><code>npm run index /path/to/transcripts ./search.db</code></pre>
  <p>Then restart the server with the database path:</p>
  <pre><code>DATABASE_PATH=./search.db npm run dev /path/to/archive</code></pre>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Convert database project slug to archive directory name.
 * Uses the pre-built mapping from buildProjectMapping().
 */
function projectToArchivePath(project: string): string {
  // Check the mapping first
  const mapped = projectToArchiveMap.get(project);
  if (mapped) {
    return mapped;
  }

  // If it doesn't start with "-", it's already a simple name
  if (!project.startsWith("-")) {
    return project;
  }

  // Fallback: try suffix matching against archive directories
  // This handles cases where the mapping wasn't built yet
  const slug = project.replace(/^-/, "");
  try {
    const entries = readdirSync(ARCHIVE_DIR, { withFileTypes: true });
    let bestMatch: string | undefined;
    let bestMatchLen = 0;

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dir = entry.name;
        if (slug === dir || slug.endsWith(`-${dir}`)) {
          if (dir.length > bestMatchLen) {
            bestMatch = dir;
            bestMatchLen = dir.length;
          }
        }
      }
    }

    if (bestMatch) {
      // Cache for future use
      projectToArchiveMap.set(project, bestMatch);
      return bestMatch;
    }
  } catch {
    // Fall through to last-segment fallback
  }

  // Last resort: return the original project
  return project;
}

// Initialize search on startup
initializeSearch();

app.listen(PORT, () => {
  console.log(`
Claude Transcript Viewer running at http://localhost:${PORT}

Serving archive from: ${ARCHIVE_DIR}
Source directory: ${SOURCE_DIR || "(not configured)"}

Usage:
  npm run dev                    # Development mode with hot reload
  npm run dev -- /path/to/archive  # Specify archive directory
  npm run dev -- /archive /source  # Specify both archive and source directory

Open http://localhost:${PORT} to browse transcripts.
`);

  // Start background archive generation and indexing after server is ready (non-blocking)
  if (SOURCE_DIR) {
    setTimeout(async () => {
      // First generate HTML archive from JSONL files
      await generateArchive();
      // Then index for search
      await startBackgroundIndexing();
    }, 1000);
  }
});
