# Article-to-Podcast Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an OpenClawd plugin that converts article/paper URLs into published podcast episodes on Spotify via NotebookLM and RSS.

**Architecture:** The plugin wraps notebooklm-py (Google NotebookLM API) for audio generation and adds Azure Blob Storage publishing with RSS feed management. OpenClawd's skill system handles intent detection and invocation from Signal. Python scripts do the heavy lifting; index.ts registers commands and config.

**Tech Stack:** TypeScript (plugin entry), Python 3.10+ (scripts), notebooklm-py, azure-storage-blob, XML (RSS feed)

**Design doc:** `docs/plans/2026-02-03-article-podcast-design.md` in the tools repo

---

### Task 1: Scaffold the Plugin

**Files:**
- Create: `openclaw-plugin-article-podcast/package.json`
- Create: `openclaw-plugin-article-podcast/openclaw.plugin.json`
- Create: `openclaw-plugin-article-podcast/index.ts`
- Create: `openclaw-plugin-article-podcast/requirements.txt`
- Create: `openclaw-plugin-article-podcast/.gitignore`

**Step 1: Initialize the repo**

```bash
mkdir -p /Users/varunr/projects/openclaw-plugin-article-podcast
cd /Users/varunr/projects/openclaw-plugin-article-podcast
git init
```

**Step 2: Create package.json**

```json
{
  "name": "openclaw-plugin-article-podcast",
  "version": "0.1.0",
  "description": "Convert articles and papers to podcast episodes via NotebookLM and publish to Spotify RSS",
  "main": "index.ts",
  "license": "MIT",
  "keywords": ["openclaw", "plugin", "podcast", "notebooklm", "rss"],
  "files": ["index.ts", "openclaw.plugin.json", "skills/", "requirements.txt"],
  "openclaw": {
    "extensions": ["./index.ts"],
    "install": {
      "npmSpec": "openclaw-plugin-article-podcast",
      "defaultChoice": "npm"
    }
  },
  "peerDependencies": {
    "openclaw": ">=2026.0.0"
  }
}
```

**Step 3: Create openclaw.plugin.json**

```json
{
  "id": "openclaw-plugin-article-podcast",
  "name": "Article Podcast",
  "description": "Convert articles and papers into podcast episodes published to Spotify via RSS",
  "version": "0.1.0",
  "configSchema": {
    "type": "object",
    "properties": {
      "notebooklm_format": {
        "type": "string",
        "description": "Default NotebookLM audio format: deep-dive, brief, critique, or debate",
        "default": "deep-dive"
      },
      "technical_instructions": {
        "type": "string",
        "description": "Instructions for technical/SWE content",
        "default": "Audience: CS undergrad level with industry experience. Be practical, focus on real-world application. Explain all technical terms with emphasis on how they are used in practice."
      },
      "general_instructions": {
        "type": "string",
        "description": "Instructions for general/non-technical content",
        "default": "Make it engaging and accessible. Explain any concepts that are not generally known."
      },
      "azure_storage_account": {
        "type": "string",
        "description": "Azure Storage account name"
      },
      "azure_container": {
        "type": "string",
        "description": "Azure Blob container name for podcast files",
        "default": "podcasts"
      },
      "feed_title": {
        "type": "string",
        "description": "Podcast feed title",
        "default": "Varun's Reading List"
      },
      "feed_author": {
        "type": "string",
        "description": "Podcast feed author name",
        "default": "Varun"
      },
      "feed_description": {
        "type": "string",
        "description": "Podcast feed description",
        "default": "AI-generated podcast discussions of articles and papers"
      },
      "feed_url": {
        "type": "string",
        "description": "Public URL of the RSS feed XML"
      },
      "feed_image_url": {
        "type": "string",
        "description": "URL of the podcast cover art image"
      }
    },
    "required": ["azure_storage_account", "feed_url"],
    "additionalProperties": false
  },
  "uiHints": {
    "azure_storage_account": {
      "label": "Azure Storage Account",
      "placeholder": "mypodcaststorage"
    },
    "feed_url": {
      "label": "Feed URL",
      "placeholder": "https://account.blob.core.windows.net/podcasts/feed.xml"
    }
  },
  "skills": ["skills/article-podcast"]
}
```

**Step 4: Create minimal index.ts**

```typescript
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const PLUGIN_ID = "openclaw-plugin-article-podcast";
const SCRIPTS_DIR = join(__dirname, "skills", "article-podcast", "scripts");

export default function register(api: any) {
  const config = api.pluginConfig || {};
  const log = api.logger;

  log.info(`${PLUGIN_ID} loaded`);
}
```

This is a minimal entry point. We add commands in later tasks as we build the scripts.

**Step 5: Create requirements.txt**

```
notebooklm-py>=0.3.0
azure-storage-blob>=12.0.0
```

**Step 6: Create .gitignore**

```
node_modules/
__pycache__/
*.pyc
.env
venv/
```

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: scaffold openclaw-plugin-article-podcast"
```

---

### Task 2: Write the Skill Definition

**Files:**
- Create: `skills/article-podcast/SKILL.md`

**Step 1: Create the skill directory**

```bash
mkdir -p skills/article-podcast/scripts
mkdir -p skills/article-podcast/references
```

**Step 2: Write SKILL.md**

The skill description must be specific enough that OpenClawd invokes it when users send article URLs and express intent to listen/podcast. Reference `${CLAUDE_PLUGIN_ROOT}` for script paths.

```markdown
---
name: article-podcast
description: This skill should be used when the user wants to convert an article, blog post, research paper, or any URL into a podcast episode. Triggers include sending a URL with intent to listen, phrases like "podcast this", "make this a podcast", "queue this up", "listen to this", or "add this to my feed". Also triggers when the user sends an arXiv link, a PDF URL, or a news article URL and wants audio content generated from it.
version: 1.0.0
---

# Article Podcast -- URL to Published Podcast Episode

## Overview

This skill converts articles, papers, and blog posts into podcast episodes
published to an RSS feed. It uses Google NotebookLM for audio generation
and Azure Blob Storage for hosting.

## When to Use

Activate this skill when:
- The user sends a URL and wants it converted to a podcast
- The user says "podcast this", "listen to this", "queue this up"
- The user sends an article/paper URL and wants audio content

## Workflow

### 1. Generate the Podcast

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/skills/article-podcast/scripts/generate.py \
  --url "<article_url>" \
  --format "<deep-dive|brief|critique|debate>" \
  --instructions "<custom instructions or auto>"
```

The `--instructions` flag accepts either `auto` (default, selects based on
content type) or a custom string. When set to `auto`, the script classifies
the content as technical/SWE or general, then applies the corresponding
instruction profile from the plugin config.

The script:
1. Creates a NotebookLM notebook
2. Adds the URL as a source
3. Generates audio with the chosen format and instructions
4. Downloads the MP3 to a temp directory
5. Prints the local MP3 path and episode metadata as JSON to stdout

### 2. Publish to Feed

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/skills/article-podcast/scripts/publish.py \
  --mp3 "<path_to_mp3>" \
  --title "<episode_title>" \
  --description "<episode_description>" \
  --duration "<duration_seconds>"
```

The script:
1. Uploads the MP3 to Azure Blob Storage
2. Downloads the current feed.xml
3. Adds a new item for this episode
4. Re-uploads feed.xml
5. Prints the public episode URL to stdout

### 3. Confirm to User

After both scripts complete, report back to the user with:
- Episode title
- Duration
- That it will appear on Spotify shortly

## Per-Request Overrides

Users can override defaults via natural language:
- "make this brief" -> `--format brief`
- "do a critique" -> `--format critique`
- "focus on the methodology" -> `--instructions "Focus on the methodology"`

## Error Handling

- If the URL is inaccessible, report to the user and ask if it is paywalled
- If NotebookLM generation fails, offer to retry
- If Azure upload fails, report and offer to retry in a few minutes

## Configuration

All defaults come from the plugin config in openclaw.plugin.json. See the
plugin README for setup instructions.
```

**Step 3: Commit**

```bash
git add skills/
git commit -m "feat: add article-podcast skill definition"
```

---

### Task 3: Write the Generate Script

**Files:**
- Create: `skills/article-podcast/scripts/generate.py`
- Test: manual test with a sample URL

**Step 1: Write generate.py**

This script orchestrates notebooklm-py to create a notebook, add the URL,
generate audio, and download the MP3. It reads plugin config from
environment variables or a config file passed via `--config`.

Key behavior:
- Accepts `--url`, `--format`, `--instructions`, `--config` args
- When `--instructions auto`, classifies content by checking the URL and
  page title against keywords (arxiv, github, engineering blog domains,
  terms like "algorithm", "distributed", "API", etc.)
- Calls notebooklm-py async API: create notebook, add_url, generate_audio,
  wait_for_completion, download_audio
- Outputs JSON to stdout: `{"mp3_path": "...", "title": "...", "description": "...", "duration_seconds": N}`
- Cleans up the notebook after download (optional, configurable)

```python
#!/usr/bin/env python3
"""Generate a podcast episode from a URL via NotebookLM."""

import argparse
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

from mutagen.mp3 import MP3

# Technical content indicators
TECHNICAL_DOMAINS = [
    "arxiv.org", "github.com", "engineering.", "eng.",
    "developer.", "devblogs.", "research.", "dl.acm.org",
    "ieeexplore.", "proceedings.", "openreview.net",
]
TECHNICAL_KEYWORDS = [
    "algorithm", "distributed", "kubernetes", "docker", "api",
    "microservice", "database", "compiler", "runtime", "latency",
    "throughput", "scalab", "concurren", "parallel", "machine learning",
    "neural", "transformer", "LLM", "GPU", "CPU", "memory",
    "cache", "protocol", "encryption", "authentication",
]


def is_technical(url: str, title: str) -> bool:
    """Classify content as technical/SWE based on URL and title."""
    text = (url + " " + title).lower()
    if any(domain in text for domain in TECHNICAL_DOMAINS):
        return True
    if sum(1 for kw in TECHNICAL_KEYWORDS if kw.lower() in text) >= 2:
        return True
    return False


def get_duration_seconds(mp3_path: str) -> int:
    """Get duration of an MP3 file in seconds."""
    audio = MP3(mp3_path)
    return int(audio.info.length)


async def generate(url: str, fmt: str, instructions: str, config: dict) -> dict:
    """Generate podcast audio from a URL."""
    from notebooklm import NotebookLMClient

    async with await NotebookLMClient.from_storage() as client:
        # Create notebook
        nb = await client.notebooks.create("Podcast")

        try:
            # Add source
            await client.sources.add_url(nb.id, url, wait=True)

            # Resolve instructions
            if instructions == "auto":
                # Get notebook info for title
                info = await client.notebooks.get(nb.id)
                title = info.title or url
                if is_technical(url, title):
                    instructions = config.get(
                        "technical_instructions",
                        "Audience: CS undergrad level with industry experience. "
                        "Be practical, focus on real-world application. "
                        "Explain all technical terms with emphasis on how they "
                        "are used in practice.",
                    )
                else:
                    instructions = config.get(
                        "general_instructions",
                        "Make it engaging and accessible. "
                        "Explain any concepts that are not generally known.",
                    )

            # Build generation instructions
            gen_instructions = instructions
            if fmt and fmt != "deep-dive":
                gen_instructions = f"Format: {fmt}. {gen_instructions}"

            # Generate audio
            status = await client.artifacts.generate_audio(
                nb.id, instructions=gen_instructions
            )
            await client.artifacts.wait_for_completion(nb.id, status.task_id)

            # Download
            tmp_dir = tempfile.mkdtemp(prefix="podcast-")
            mp3_path = os.path.join(tmp_dir, "episode.mp3")
            await client.artifacts.download_audio(nb.id, mp3_path)

            # Get metadata
            info = await client.notebooks.get(nb.id)
            title = info.title or "Untitled Episode"
            duration = get_duration_seconds(mp3_path)

            return {
                "mp3_path": mp3_path,
                "title": title,
                "description": f"AI-generated podcast discussion of: {url}",
                "duration_seconds": duration,
                "source_url": url,
            }
        finally:
            # Clean up notebook
            try:
                await client.notebooks.delete(nb.id)
            except Exception:
                pass


def main():
    parser = argparse.ArgumentParser(description="Generate podcast from URL")
    parser.add_argument("--url", required=True, help="Article URL")
    parser.add_argument("--format", default="deep-dive",
                        choices=["deep-dive", "brief", "critique", "debate"])
    parser.add_argument("--instructions", default="auto",
                        help="Custom instructions or 'auto' for content-based selection")
    parser.add_argument("--config", default=None,
                        help="Path to JSON config file with plugin settings")
    args = parser.parse_args()

    config = {}
    if args.config and os.path.exists(args.config):
        with open(args.config) as f:
            config = json.load(f)

    result = asyncio.run(generate(args.url, args.format, args.instructions, config))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
```

**Step 2: Test manually**

Requires notebooklm-py to be installed and authenticated on the target machine.
For local testing without NotebookLM auth, verify the script parses args and
the classification logic works:

```bash
python3 skills/article-podcast/scripts/generate.py --url "https://arxiv.org/abs/2401.12345" --format deep-dive --instructions auto --help
```

**Step 3: Commit**

```bash
git add skills/article-podcast/scripts/generate.py
git commit -m "feat: add podcast generation script using notebooklm-py"
```

---

### Task 4: Write the RSS Feed Manager

**Files:**
- Create: `skills/article-podcast/scripts/feed.py`
- Test: `tests/test_feed.py`

**Step 1: Write the failing test**

```python
"""Tests for RSS feed generation and management."""
import os
import tempfile
from xml.etree import ElementTree as ET

from skills.article_podcast.scripts.feed import create_feed, add_episode, parse_feed


def test_create_feed_produces_valid_rss():
    """A new feed has the correct root structure and channel metadata."""
    xml = create_feed(
        title="Test Podcast",
        description="A test feed",
        author="Tester",
        feed_url="https://example.com/feed.xml",
        image_url="https://example.com/cover.jpg",
    )
    root = ET.fromstring(xml)
    assert root.tag == "rss"
    channel = root.find("channel")
    assert channel is not None
    assert channel.find("title").text == "Test Podcast"
    assert channel.find("description").text == "A test feed"


def test_add_episode_prepends_item():
    """Adding an episode puts it at the top of the feed."""
    xml = create_feed(
        title="Test Podcast",
        description="A test feed",
        author="Tester",
        feed_url="https://example.com/feed.xml",
        image_url="https://example.com/cover.jpg",
    )
    updated = add_episode(
        feed_xml=xml,
        title="Episode 1",
        description="First episode",
        audio_url="https://example.com/ep1.mp3",
        duration_seconds=600,
        source_url="https://example.com/article",
    )
    root = ET.fromstring(updated)
    items = root.find("channel").findall("item")
    assert len(items) == 1
    assert items[0].find("title").text == "Episode 1"

    # Add second episode -- should be first in feed
    updated2 = add_episode(
        feed_xml=updated,
        title="Episode 2",
        description="Second episode",
        audio_url="https://example.com/ep2.mp3",
        duration_seconds=1200,
        source_url="https://example.com/article2",
    )
    root2 = ET.fromstring(updated2)
    items2 = root2.find("channel").findall("item")
    assert len(items2) == 2
    assert items2[0].find("title").text == "Episode 2"
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/varunr/projects/openclaw-plugin-article-podcast
python3 -m pytest tests/test_feed.py -v
```

Expected: ImportError -- module does not exist yet.

**Step 3: Write feed.py**

```python
#!/usr/bin/env python3
"""RSS feed management for podcast episodes."""

import uuid
from datetime import datetime, timezone
from email.utils import formatdate
from xml.etree import ElementTree as ET


ITUNES_NS = "http://www.itunes.com/dtds/podcast-1.0.dtd"
ET.register_namespace("itunes", ITUNES_NS)


def create_feed(
    title: str,
    description: str,
    author: str,
    feed_url: str,
    image_url: str,
    language: str = "en",
) -> str:
    """Create a new empty RSS feed with podcast metadata."""
    rss = ET.Element("rss", {
        "version": "2.0",
        "xmlns:itunes": ITUNES_NS,
    })
    channel = ET.SubElement(rss, "channel")

    ET.SubElement(channel, "title").text = title
    ET.SubElement(channel, "description").text = description
    ET.SubElement(channel, "language").text = language
    ET.SubElement(channel, "link").text = feed_url

    ET.SubElement(channel, f"{{{ITUNES_NS}}}author").text = author
    ET.SubElement(channel, f"{{{ITUNES_NS}}}owner")
    owner = channel.find(f"{{{ITUNES_NS}}}owner")
    ET.SubElement(owner, f"{{{ITUNES_NS}}}name").text = author

    image = ET.SubElement(channel, f"{{{ITUNES_NS}}}image", {"href": image_url})

    ET.SubElement(channel, f"{{{ITUNES_NS}}}explicit").text = "false"
    ET.SubElement(channel, f"{{{ITUNES_NS}}}category", {"text": "Technology"})

    return ET.tostring(rss, encoding="unicode", xml_declaration=True)


def add_episode(
    feed_xml: str,
    title: str,
    description: str,
    audio_url: str,
    duration_seconds: int,
    source_url: str,
) -> str:
    """Add a new episode to the feed, prepended as the first item."""
    root = ET.fromstring(feed_xml)
    channel = root.find("channel")

    item = ET.Element("item")
    ET.SubElement(item, "title").text = title
    ET.SubElement(item, "description").text = description
    ET.SubElement(item, "link").text = source_url
    ET.SubElement(item, "guid", {"isPermaLink": "false"}).text = str(uuid.uuid4())
    ET.SubElement(item, "pubDate").text = formatdate(usegmt=True)
    ET.SubElement(item, "enclosure", {
        "url": audio_url,
        "type": "audio/mpeg",
        "length": "0",  # updated after upload if size known
    })

    # Format duration as HH:MM:SS
    hours, remainder = divmod(duration_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    duration_str = f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    ET.SubElement(item, f"{{{ITUNES_NS}}}duration").text = duration_str
    ET.SubElement(item, f"{{{ITUNES_NS}}}summary").text = description

    # Prepend: insert before first existing item, or at end of channel
    existing_items = channel.findall("item")
    if existing_items:
        idx = list(channel).index(existing_items[0])
        channel.insert(idx, item)
    else:
        channel.append(item)

    return ET.tostring(root, encoding="unicode", xml_declaration=True)


def parse_feed(feed_xml: str) -> dict:
    """Parse feed and return metadata and episode count."""
    root = ET.fromstring(feed_xml)
    channel = root.find("channel")
    return {
        "title": channel.find("title").text,
        "episode_count": len(channel.findall("item")),
    }
```

**Step 4: Run tests to verify they pass**

```bash
python3 -m pytest tests/test_feed.py -v
```

Expected: both tests PASS.

**Step 5: Commit**

```bash
git add skills/article-podcast/scripts/feed.py tests/test_feed.py
git commit -m "feat: add RSS feed manager with tests"
```

---

### Task 5: Write the Publish Script

**Files:**
- Create: `skills/article-podcast/scripts/publish.py`

**Step 1: Write publish.py**

This script uploads the MP3 to Azure Blob Storage, updates the RSS feed,
and re-uploads the feed.

```python
#!/usr/bin/env python3
"""Upload podcast episode to Azure and update RSS feed."""

import argparse
import json
import os
import sys
from pathlib import Path

from azure.storage.blob import BlobServiceClient, ContentSettings

# Add parent for feed module import
sys.path.insert(0, os.path.dirname(__file__))
from feed import add_episode, create_feed


def slugify(text: str) -> str:
    """Convert text to URL-safe slug."""
    import re
    slug = text.lower().strip()
    slug = re.sub(r"[^\w\s-]", "", slug)
    slug = re.sub(r"[\s_]+", "-", slug)
    slug = re.sub(r"-+", "-", slug)
    return slug[:80]


def publish(
    mp3_path: str,
    title: str,
    description: str,
    duration_seconds: int,
    source_url: str,
    config: dict,
) -> dict:
    """Upload MP3 and update RSS feed. Returns public URLs."""

    conn_str = os.environ.get("AZURE_STORAGE_CONNECTION_STRING", "")
    if not conn_str:
        raise ValueError("AZURE_STORAGE_CONNECTION_STRING not set")

    container = config.get("azure_container", "podcasts")
    feed_url = config["feed_url"]
    account = config["azure_storage_account"]
    base_url = f"https://{account}.blob.core.windows.net/{container}"

    blob_service = BlobServiceClient.from_connection_string(conn_str)
    container_client = blob_service.get_container_client(container)

    # Upload MP3
    slug = slugify(title)
    blob_name = f"episodes/{slug}.mp3"
    audio_url = f"{base_url}/{blob_name}"

    with open(mp3_path, "rb") as f:
        container_client.upload_blob(
            blob_name,
            f,
            overwrite=True,
            content_settings=ContentSettings(content_type="audio/mpeg"),
        )

    # Download or create feed.xml
    feed_blob = container_client.get_blob_client("feed.xml")
    try:
        feed_xml = feed_blob.download_blob().readall().decode("utf-8")
    except Exception:
        # First episode -- create the feed
        feed_xml = create_feed(
            title=config.get("feed_title", "My Podcast"),
            description=config.get("feed_description", "AI-generated podcast"),
            author=config.get("feed_author", ""),
            feed_url=feed_url,
            image_url=config.get("feed_image_url", ""),
        )

    # Add episode
    updated_feed = add_episode(
        feed_xml=feed_xml,
        title=title,
        description=description,
        audio_url=audio_url,
        duration_seconds=duration_seconds,
        source_url=source_url,
    )

    # Upload updated feed
    feed_blob.upload_blob(
        updated_feed.encode("utf-8"),
        overwrite=True,
        content_settings=ContentSettings(content_type="application/rss+xml"),
    )

    return {
        "audio_url": audio_url,
        "feed_url": feed_url,
    }


def main():
    parser = argparse.ArgumentParser(description="Publish podcast episode")
    parser.add_argument("--mp3", required=True, help="Path to MP3 file")
    parser.add_argument("--title", required=True, help="Episode title")
    parser.add_argument("--description", required=True, help="Episode description")
    parser.add_argument("--duration", required=True, type=int,
                        help="Duration in seconds")
    parser.add_argument("--source-url", required=True, help="Original article URL")
    parser.add_argument("--config", required=True, help="Path to JSON config file")
    args = parser.parse_args()

    with open(args.config) as f:
        config = json.load(f)

    result = publish(
        mp3_path=args.mp3,
        title=args.title,
        description=args.description,
        duration_seconds=args.duration,
        source_url=args.source_url,
        config=config,
    )
    print(json.dumps(result))


if __name__ == "__main__":
    main()
```

**Step 2: Commit**

```bash
git add skills/article-podcast/scripts/publish.py
git commit -m "feat: add Azure publish script with RSS feed update"
```

---

### Task 6: Wire Up index.ts

**Files:**
- Modify: `index.ts`

**Step 1: Update index.ts to write config and expose a command**

The index.ts writes the plugin config to a JSON file that the Python scripts
read. It also registers a `/podcast` command for terminal use (though the
primary trigger is Signal via skill invocation).

```typescript
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PLUGIN_ID = "openclaw-plugin-article-podcast";
const SCRIPTS_DIR = join(__dirname, "skills", "article-podcast", "scripts");
const CONFIG_DIR = join(homedir(), ".openclaw", "plugins", PLUGIN_ID);
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export default function register(api: any) {
  const config = api.pluginConfig || {};
  const log = api.logger;

  // Write config for Python scripts
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

  log.info(`${PLUGIN_ID} loaded, config at ${CONFIG_FILE}`);
}
```

**Step 2: Commit**

```bash
git add index.ts
git commit -m "feat: wire index.ts to write config for Python scripts"
```

---

### Task 7: Update requirements.txt and Add Setup Docs

**Files:**
- Modify: `requirements.txt`
- Create: `README.md`

**Step 1: Update requirements.txt with all deps**

```
notebooklm-py>=0.3.0
azure-storage-blob>=12.0.0
mutagen>=1.47.0
```

(`mutagen` is needed for MP3 duration detection in generate.py)

**Step 2: Write README.md with setup instructions**

Cover:
- Prerequisites: Python 3.10+, notebooklm-py authenticated, Azure Storage account
- Installation: `npm install openclaw-plugin-article-podcast`
- Python deps: `pip install -r requirements.txt`
- Config: fill in `azure_storage_account`, `feed_url` in plugin config
- One-time: `notebooklm login`, create Azure container, upload cover art
- Spotify: register feed URL at podcasters.spotify.com
- Usage: send a URL on Signal

**Step 3: Commit**

```bash
git add requirements.txt README.md
git commit -m "docs: add setup instructions and finalize dependencies"
```

---

### Task 8: End-to-End Test on Surface Pro

**Prerequisites:** SSH access to Surface Pro (moltbot@100.107.15.52)

**Step 1: Install the plugin**

```bash
# On Surface Pro
cd /path/to/plugin
pip install -r requirements.txt
openclaw plugin install .
```

**Step 2: Configure the plugin**

Set `AZURE_STORAGE_CONNECTION_STRING` in environment. Configure plugin
settings via `openclaw config set`.

**Step 3: Create Azure container**

```bash
az storage container create --name podcasts --public-access blob
```

**Step 4: Test generate script standalone**

```bash
python3 skills/article-podcast/scripts/generate.py \
  --url "https://example.com/short-article" \
  --format brief \
  --instructions auto \
  --config ~/.openclaw/plugins/openclaw-plugin-article-podcast/config.json
```

Verify: JSON output with mp3_path, title, duration.

**Step 5: Test publish script standalone**

```bash
python3 skills/article-podcast/scripts/publish.py \
  --mp3 /tmp/episode.mp3 \
  --title "Test Episode" \
  --description "Testing the pipeline" \
  --duration 300 \
  --source-url "https://example.com" \
  --config ~/.openclaw/plugins/openclaw-plugin-article-podcast/config.json
```

Verify: MP3 accessible at Azure URL, feed.xml updated with new item.

**Step 6: Test full flow via Signal**

Send a URL to Bhavana on Signal. Verify:
- She acknowledges the request
- Audio generates successfully
- MP3 appears in Azure
- RSS feed updates
- Confirmation message on Signal with title and duration

**Step 7: Register with Spotify**

Go to podcasters.spotify.com, submit the feed URL. Verify Spotify finds
the test episode.

**Step 8: Commit any fixes from testing**

```bash
git add -A
git commit -m "fix: adjustments from E2E testing"
```
