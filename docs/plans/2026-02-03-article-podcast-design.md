# Article-to-Podcast Plugin Design

**Date:** 2026-02-03
**Plugin:** `openclaw-plugin-article-podcast`
**Status:** Draft

## Problem

Sending articles and papers to NotebookLM for podcast generation requires multiple manual clicks through the web UI. The goal: send a URL on Signal, get a published podcast episode on Spotify.

## Approach

Build an OpenClawd plugin that layers on top of [notebooklm-py](https://github.com/teng-lin/notebooklm-py), an unofficial Python wrapper around Google NotebookLM's backend. The plugin adds content classification, instruction selection, Azure storage, and RSS feed publishing.

notebooklm-py handles notebook creation, source ingestion, and audio generation. Our plugin handles everything before and after: detecting intent, choosing the right instructions, and publishing the finished audio to a podcast feed.

## Pipeline

```
Signal URL
  -> OpenClawd invokes podcast skill
  -> Classify content type (SWE/technical vs general)
  -> Select instruction profile
  -> notebooklm-py: create notebook -> add source -> generate audio -> download MP3
  -> Upload MP3 to Azure Blob Storage
  -> Update RSS feed.xml -> re-upload to Azure
  -> Bhavana confirms on Signal with title + duration
  -> Spotify polls feed, episode appears
```

## Content Classification & Instructions

The plugin classifies content before generating audio. Classification determines which instruction profile to use.

### Technical / SWE content
Articles about software engineering, systems design, programming languages, ML/AI research, distributed systems, and similar topics.

> Audience: CS undergraduate level with industry experience. Be practical and focus on real-world application of concepts. Explain all technical terms and concepts with emphasis on how they are used in practice, not just theory.

### General content
News, opinion pieces, essays, non-technical blog posts, and everything else.

> Make it engaging and accessible. Explain any concepts that are not generally known.

The LLM classifies the content as part of the skill invocation. No separate classification step.

## Audio Format

NotebookLM supports four formats:
- **deep-dive** (default) -- thorough two-host discussion
- **brief** -- condensed overview
- **critique** -- critical analysis
- **debate** -- opposing viewpoints

Default: deep-dive. Overridable per request via natural language ("make this brief").

## Length

Length adapts to content density. NotebookLM controls this internally, but the instruction profile and format selection influence it:
- Dense technical papers: 30-60+ minutes
- Technical blog posts: 15-25 minutes
- News articles: 8-12 minutes
- Short/simple articles: 8-15 minutes

## Plugin Configuration

```json
{
  "notebooklm": {
    "format": "deep-dive",
    "technicalInstructions": "Audience: CS undergrad level with industry experience. Be practical, focus on real-world application. Explain all technical terms with emphasis on how they are used in practice.",
    "generalInstructions": "Make it engaging and accessible. Explain any concepts that are not generally known."
  },
  "azure": {
    "storageAccount": "",
    "container": "podcasts",
    "connectionString": "env:AZURE_STORAGE_CONNECTION_STRING"
  },
  "feed": {
    "title": "Varun's Reading List",
    "description": "AI-generated podcast discussions of articles and papers",
    "author": "Varun",
    "feedUrl": "https://<account>.blob.core.windows.net/podcasts/feed.xml",
    "imageUrl": "https://<account>.blob.core.windows.net/podcasts/cover.jpg"
  }
}
```

## Signal UX

Standard request:
```
You:     https://arxiv.org/abs/2401.12345
Bhavana: Generating podcast from "Attention Is All You Need Again"...
         Format: deep-dive
Bhavana: Published! "Attention Is All You Need Again" (28 min).
         It will appear on Spotify shortly.
```

With overrides:
```
You:     make this brief https://blog.example.com/some-post
Bhavana: Generating brief podcast from "Some Post Title"...
Bhavana: Published! "Some Post Title" (8 min).
```

Multiple URLs queue and process sequentially.

## Error Handling

- **URL inaccessible**: "Couldn't access that URL. Is it behind a paywall?"
- **Generation failure**: "Audio generation failed. Want me to retry?"
- **Upload failure**: "Generated the audio but couldn't publish. I'll retry in a few minutes."

## RSS Feed

A single XML file (`feed.xml`) in Azure Blob Storage. Each episode adds an `<item>` element with title, description, audio URL, duration, publish date, and GUID.

When a new episode publishes:
1. Download current `feed.xml` from Azure
2. Generate new `<item>` with episode metadata
3. Prepend the item (newest first)
4. Re-upload `feed.xml`

## Spotify Integration

One-time setup:
1. Register at podcasters.spotify.com
2. Submit the RSS feed URL
3. Spotify validates the feed and begins polling
4. New episodes appear automatically (typically within a few hours)

The same feed works with Apple Podcasts, Pocket Casts, Overcast, and other podcast apps.

## Azure Blob Storage

- Container `podcasts` with public read access
- Audio files at `episodes/<slug>.mp3`
- Feed at `feed.xml` in the container root
- Optional: custom domain via Azure CDN

## Dependencies

- **notebooklm-py** -- NotebookLM API wrapper (audio generation)
- **azure-storage-blob** -- Azure Blob Storage SDK (publishing)
- **feedgen** or manual XML -- RSS feed generation

## Project Structure

```
openclaw-plugin-article-podcast/
  openclaw.plugin.json
  package.json
  index.ts                    # plugin entry: config, commands
  skills/
    article-podcast/
      SKILL.md                # skill definition for OpenClawd
      scripts/
        generate.py           # orchestrates: classify -> notebooklm -> download
        publish.py            # upload to Azure, update RSS feed
        feed.py               # RSS feed XML management
  requirements.txt            # Python deps: notebooklm-py, azure-storage-blob
```

## One-Time Setup Steps

1. Install notebooklm-py on the Surface Pro, run `notebooklm login`
2. Create Azure Storage account + `podcasts` container with public read
3. Set `AZURE_STORAGE_CONNECTION_STRING` in environment
4. Upload a podcast cover image to `podcasts/cover.jpg`
5. Generate an initial `feed.xml` with at least one episode
6. Register feed URL with Spotify for Podcasters
7. Install the plugin in OpenClawd
