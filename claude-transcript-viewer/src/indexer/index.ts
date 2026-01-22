/**
 * Indexer for JSONL transcripts.
 * Parses transcripts, chunks content, gets embeddings, stores in database.
 */
import { readdirSync, statSync } from "fs";
import { join, basename, dirname } from "path";
import { createDatabase, getDatabase, closeDatabase, setMetadata, getMetadata } from "../db/index.js";
import { insertConversation, getConversation, deleteConversation } from "../db/conversations.js";
import { insertChunk } from "../db/chunks.js";
import { parseTranscript, Message } from "./parser.js";
import { chunkText } from "./chunker.js";
import { getFileHash, getFileMtime } from "./fileUtils.js";
import { createEmbeddingClient, EmbeddingClient } from "../embeddings/client.js";

export interface IndexOptions {
  sourceDir: string;
  databasePath: string;
  embedSocketPath?: string;
  batchSize?: number;
  verbose?: boolean;
}

export interface IndexStats {
  added: number;
  modified: number;
  deleted: number;
  chunks: number;
  errors: string[];
}

/**
 * Find all JSONL files in a directory recursively.
 */
function findJsonlFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(currentDir: string) {
    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(fullPath);
        }
      }
    } catch (err) {
      // Skip directories we can't read
    }
  }

  walk(dir);
  return files;
}

/**
 * Extract conversation ID from file path.
 * Assumes format: .../project/conversation-id.jsonl
 */
function extractConversationId(filePath: string): string {
  return basename(filePath, ".jsonl");
}

/**
 * Extract project name from file path.
 * Assumes format: .../project/conversation-id.jsonl
 */
function extractProject(filePath: string, sourceDir: string): string {
  const relativePath = filePath.replace(sourceDir, "").replace(/^\//, "");
  const parts = relativePath.split("/");
  return parts.length > 1 ? parts[0] : "default";
}

/**
 * Index a single transcript file.
 */
async function indexTranscript(
  filePath: string,
  sourceDir: string,
  embeddingClient?: EmbeddingClient,
  verbose?: boolean
): Promise<{ chunks: number; error?: string }> {
  const db = getDatabase();
  const conversationId = extractConversationId(filePath);
  const project = extractProject(filePath, sourceDir);

  try {
    // Parse the transcript
    const messages = parseTranscript(filePath);
    if (messages.length === 0) {
      return { chunks: 0 };
    }

    // Get file metadata
    const contentHash = getFileHash(filePath);
    const mtime = getFileMtime(filePath);

    // Extract title from first user message
    const firstUserMsg = messages.find((m) => m.role === "user");
    const title = firstUserMsg?.content.slice(0, 100) || "Untitled";

    // Use current time as created_at (JSONL doesn't have timestamps)
    const createdAt = new Date().toISOString();

    // Delete existing conversation if it exists (will cascade delete chunks)
    const existing = getConversation(conversationId);
    if (existing) {
      deleteConversation(conversationId);
    }

    // Insert conversation
    insertConversation({
      id: conversationId,
      project,
      title,
      created_at: createdAt,
      file_path: filePath,
      content_hash: contentHash,
      source_mtime: mtime,
    });

    // Chunk and index each message
    let chunkCount = 0;
    let pageNumber = 1;

    for (const message of messages) {
      const chunks = chunkText(message.content, {
        maxTokens: 300,
        overlap: 50,
      });

      for (let i = 0; i < chunks.length; i++) {
        const chunkText_ = chunks[i];
        let embedding: Buffer | null = null;

        // Get embedding if client available
        if (embeddingClient) {
          const result = await embeddingClient.embed(chunkText_);
          if (result) {
            embedding = Buffer.from(new Float32Array(result.embedding).buffer);
          }
        }

        insertChunk({
          conversation_id: conversationId,
          chunk_index: chunkCount,
          page_number: pageNumber,
          role: message.role,
          content: chunkText_,
          embedding,
        });

        chunkCount++;
      }

      // Increment page number periodically (roughly every 10 messages)
      if (chunkCount > 0 && chunkCount % 30 === 0) {
        pageNumber++;
      }
    }

    if (verbose) {
      console.log(`  Indexed ${conversationId}: ${chunkCount} chunks`);
    }

    return { chunks: chunkCount };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { chunks: 0, error };
  }
}

/**
 * Run the full indexing process.
 */
export async function runIndexer(options: IndexOptions): Promise<IndexStats> {
  const {
    sourceDir,
    databasePath,
    embedSocketPath,
    batchSize = 10,
    verbose = false,
  } = options;

  const stats: IndexStats = {
    added: 0,
    modified: 0,
    deleted: 0,
    chunks: 0,
    errors: [],
  };

  // Initialize database
  createDatabase(databasePath);
  const db = getDatabase();

  // Connect to embedding server if available
  let embeddingClient: EmbeddingClient | undefined;
  if (embedSocketPath) {
    embeddingClient = createEmbeddingClient(embedSocketPath);
    const healthy = await embeddingClient.isHealthy();
    if (healthy) {
      console.log(`Connected to embedding server at ${embedSocketPath}`);
    } else {
      console.log(`Embedding server not available - indexing without embeddings`);
      embeddingClient = undefined;
    }
  }

  // Find all JSONL files
  const files = findJsonlFiles(sourceDir);
  console.log(`Found ${files.length} JSONL files in ${sourceDir}`);

  // Detect changes
  const indexed = db
    .prepare("SELECT id, file_path, content_hash, source_mtime FROM conversations")
    .all() as Array<{
    id: string;
    file_path: string;
    content_hash: string;
    source_mtime: number;
  }>;

  const indexedMap = new Map(indexed.map((c) => [c.file_path, c]));
  const fileSet = new Set(files);

  // Determine what needs to be indexed
  const toIndex: string[] = [];
  const toDelete: string[] = [];

  for (const file of files) {
    const existing = indexedMap.get(file);
    if (!existing) {
      toIndex.push(file);
      stats.added++;
    } else {
      // Check if modified
      const mtime = getFileMtime(file);
      if (mtime !== existing.source_mtime) {
        const hash = getFileHash(file);
        if (hash !== existing.content_hash) {
          toIndex.push(file);
          stats.modified++;
        }
      }
    }
  }

  // Find deleted files
  for (const [filePath, conv] of indexedMap) {
    if (!fileSet.has(filePath)) {
      toDelete.push(conv.id);
      stats.deleted++;
    }
  }

  // Delete removed conversations
  for (const id of toDelete) {
    deleteConversation(id);
    if (verbose) {
      console.log(`  Deleted ${id}`);
    }
  }

  // Index new/modified files
  console.log(`Indexing ${toIndex.length} files (${stats.added} new, ${stats.modified} modified)`);

  for (let i = 0; i < toIndex.length; i++) {
    const file = toIndex[i];
    const result = await indexTranscript(file, sourceDir, embeddingClient, verbose);

    if (result.error) {
      stats.errors.push(`${file}: ${result.error}`);
    } else {
      stats.chunks += result.chunks;
    }

    // Progress indicator
    if ((i + 1) % 10 === 0 || i === toIndex.length - 1) {
      console.log(`  Progress: ${i + 1}/${toIndex.length}`);
    }
  }

  // Update metadata
  setMetadata("last_index_time", new Date().toISOString());
  setMetadata("total_conversations", String(files.length));

  console.log(`\nIndexing complete:`);
  console.log(`  Added: ${stats.added}`);
  console.log(`  Modified: ${stats.modified}`);
  console.log(`  Deleted: ${stats.deleted}`);
  console.log(`  Total chunks: ${stats.chunks}`);
  if (stats.errors.length > 0) {
    console.log(`  Errors: ${stats.errors.length}`);
  }

  return stats;
}

// CLI entry point
if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  const sourceDir = process.argv[2];
  const databasePath = process.argv[3] || "./search.db";
  const embedSocketPath = process.env.EMBED_SOCKET;

  if (!sourceDir) {
    console.error("Usage: npx tsx src/indexer/index.ts <source-dir> [database-path]");
    console.error("  source-dir: Directory containing JSONL transcript files");
    console.error("  database-path: Path to SQLite database (default: ./search.db)");
    console.error("");
    console.error("Environment variables:");
    console.error("  EMBED_SOCKET: Path to embedding server Unix socket");
    process.exit(1);
  }

  runIndexer({
    sourceDir,
    databasePath,
    embedSocketPath,
    verbose: true,
  })
    .then(() => {
      closeDatabase();
      process.exit(0);
    })
    .catch((err) => {
      console.error("Indexing failed:", err);
      closeDatabase();
      process.exit(1);
    });
}
