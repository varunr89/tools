# Claude Transcript Viewer

A web server for browsing and searching Claude Code conversation transcripts with semantic search, infinite scroll, and collapsible cells.

## Features

- **Semantic Search** - Hybrid FTS + vector search with highlighted snippets
- **Auto Archive Generation** - Automatically generates HTML from JSONL transcripts on startup
- **Background Indexing** - Non-blocking indexing of conversations for search
- **Enhanced Viewing** - Collapsible cells, preview text, infinite scroll
- **Search Everywhere** - Search bar on every page with live dropdown results
- **Full Search Page** - Dedicated search results page with filters (project, role, date)

## Quick Start

```bash
# Install dependencies
npm install

# Start with auto-generation (recommended)
SOURCE_DIR=~/.claude/projects npm run dev

# Or specify output directory
ARCHIVE_DIR=./archive SOURCE_DIR=~/.claude/projects npm run dev
```

Open http://localhost:3000 to browse transcripts.

## Installation

```bash
git clone <repo>
cd claude-transcript-viewer
npm install
```

### Requirements

- Node.js 18+
- [claude-code-transcripts](https://github.com/simonw/claude-code-transcripts) Python CLI (for HTML generation)

```bash
# Install the Python CLI
pip install claude-code-transcripts
# or
uv pip install claude-code-transcripts
```

## Usage

### Basic Usage

```bash
# Auto-generate archive and start server
SOURCE_DIR=~/.claude/projects npm run dev

# Use existing archive (no generation)
npm run dev -- /path/to/existing/archive

# Specify all paths explicitly
ARCHIVE_DIR=./archive \
SOURCE_DIR=~/.claude/projects \
DATABASE_PATH=./search.db \
npm run dev
```

### Manual Indexing

If you only want to index without running the server:

```bash
npm run index ~/.claude/projects ./search.db
```

### With Embedding Server

For semantic vector search (optional), run a compatible embedding server:

```bash
# Start embedding server (e.g., qwen3-embeddings-mlx)
EMBED_SOCKET=/tmp/qwen-embed.sock npm run dev
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `3000` | Server port |
| `ARCHIVE_DIR` | `./claude-archive` | Directory for HTML files |
| `SOURCE_DIR` | (none) | JSONL source directory (enables auto-generation) |
| `DATABASE_PATH` | `ARCHIVE_DIR/.search.db` | SQLite database path |
| `EMBED_SOCKET` | `/tmp/qwen-embed.sock` | Unix socket for embedding server |

## API Endpoints

### Search

```bash
# Search conversations
GET /api/search?q=sqlite&limit=20

# With filters
GET /api/search?q=typescript&project=my-project&role=assistant

# Parameters:
# - q: Search query
# - project: Filter by project name
# - role: Filter by role (user/assistant)
# - after: Filter by date (YYYY-MM-DD)
# - before: Filter by date (YYYY-MM-DD)
# - limit: Max results (default: 20)
# - offset: Pagination offset
```

### Status

```bash
# Get index and archive status
GET /api/index/status

# Response:
{
  "status": "ready",
  "conversations": 3471,
  "chunks": 596168,
  "embedding_server": "unavailable",
  "archive": {
    "isGenerating": false,
    "progress": "Complete",
    "lastRun": "2026-01-21T19:21:27Z"
  },
  "indexing": {
    "isIndexing": false,
    "progress": "Complete",
    "lastStats": { "added": 37, "modified": 0, "deleted": 0, "chunks": 16513 }
  }
}
```

### Manual Triggers

```bash
# Regenerate HTML archive and re-index
POST /api/archive/regenerate

# Re-index only (no HTML regeneration)
POST /api/index/reindex
```

## Pages

| Route | Description |
|-------|-------------|
| `/` | Landing page with projects and recent conversations |
| `/search?q=...` | Full search results page with filters |
| `/*.html` | Enhanced transcript pages with search bar |

## Architecture

```
JSONL files ─┬─> claude-code-transcripts (Python) ─> HTML files
             │
             └─> transcript-viewer indexer ─> SQLite (FTS + vectors)

HTML files ─> Express server ─> Enhanced HTML + Search API
```

### Search Pipeline

1. **FTS5** - Full-text search with trigram tokenizer for substring matching
2. **Vector Search** - Semantic similarity using sqlite-vec (when embedding server available)
3. **RRF Merge** - Reciprocal Rank Fusion combines both result sets
4. **Snippets** - Generates highlighted snippets around matched terms

## Development

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Build for production
npm run build

# Start production server
npm start
```

### Project Structure

```
src/
├── server.ts           # Express server, routes, HTML enhancement
├── api/
│   ├── search.ts       # Hybrid search (FTS + vector + RRF)
│   └── snippets.ts     # Snippet generation and highlighting
├── db/
│   ├── index.ts        # Database initialization
│   ├── schema.ts       # Tables, indexes, triggers
│   ├── chunks.ts       # Chunk CRUD operations
│   └── conversations.ts # Conversation CRUD operations
├── indexer/
│   ├── index.ts        # Main indexing logic
│   ├── parser.ts       # JSONL transcript parser
│   ├── chunker.ts      # Text chunking
│   └── fileUtils.ts    # File hashing, mtime detection
└── embeddings/
    └── client.ts       # Unix socket client for embedding server
```

## License

MIT
