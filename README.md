# 🎵 music-ai

AI-powered playlist generator using your local music library, Ollama, and vector search. Fully offline. No cloud. No API keys.

## How it works

1. **Scan** — reads all metadata (title, artist, genre, BPM, mood, credits, etc.) from every audio file via MusicBrainz Picard tags
2. **Analyze** — runs Essentia audio analysis on each file, extracting energy, valence, danceability, acousticness, instrumentalness, key, and more
3. **Retext** — rebuilds the metadata text blob combining file tags + acoustic features into natural language
4. **Embed** — converts each track's metadata into a vector using `nomic-embed-text` via Ollama (one-time, runs locally)
5. **Search** — when you describe a vibe, it finds similar tracks via vector similarity
6. **Curate** — sends the top candidates to a local LLM to make the final playlist
7. **Export** — saves as `.m3u` files your media player can open

Everything lives in a single `data/library.db` SQLite file.

---

## Prerequisites

### 1. Node.js v20

This project requires **Node.js v20 LTS**. Node v22+ will cause native module compilation failures with `better-sqlite3`.

If you use nvm:
```bash
nvm install 20
nvm use 20
```

To pin v20 for this project permanently:
```bash
echo "20" > .nvmrc
nvm use
```

### 2. Python 3 + Essentia

Required for acoustic analysis:
```bash
pip3 install essentia
```

> Essentia is the same audio analysis library that powered Spotify's Echo Nest. It extracts energy, valence, danceability, key, acousticness and more directly from the audio waveform.

### 3. Install Ollama
Download from [ollama.com](https://ollama.com) — it's a simple Mac app. Once installed, Ollama runs automatically in the background.

### 4. Pull the required models
```bash
ollama pull nomic-embed-text   # for embeddings (~274MB)
ollama pull llama3.1:8b        # for playlist curation (~4.7GB) — best quality
```

> See [Choosing a chat model](#choosing-a-chat-model) below for model recommendations based on your hardware.

### 5. Install Node dependencies
```bash
npm install
```

---

## Full pipeline

### Step 1 — Scan your library
```bash
npm run scan ~/Music
```
Crawls your music folder, extracts all metadata from file tags (including MusicBrainz Picard tags like mood and multiple genres), stores everything in the database. Fast — typically seconds even for large libraries.

### Step 2 — Acoustic analysis
```bash
python3 analyze.py
```
Runs Essentia on every audio file using **all available CPU cores** in parallel. Extracts energy, valence, danceability, acousticness, instrumentalness, speechiness, loudness, BPM, and key directly from the audio waveform. On an M3 Mac expect around **2 tracks/second** — a 4000 track library takes roughly 35 minutes.

```bash
python3 analyze.py --limit 20 --verbose   # test on 20 tracks first
python3 analyze.py --all                  # re-analyze everything (overwrite existing)
python3 analyze.py --workers 4            # manually set worker count
```

> Note: Run `python3 analyze.py` directly rather than via `npm run analyze` — npm doesn't pass arguments through to Python scripts cleanly.

### Step 3 — Rebuild metadata text
```bash
npm run retext
```
Combines file tag metadata with Essentia acoustic features into a rich natural language description for each track. This is what gets embedded — things like "Energy: very high. Valence: happy. Danceability: very danceable. Acousticness: electronic." Also resets embedding status so Step 4 picks up all changes.

### Step 4 — Generate embeddings
```bash
npm run embed
```
Converts every track's metadata text into a vector. On Apple Silicon with `nomic-embed-text` expect around **35 tracks/second** — a 4000 track library takes roughly 2 minutes. Only runs on tracks that haven't been embedded yet (or were reset by `retext`).

### Step 5 — Generate playlists!

**Vibe mode** — describe what you want:
```bash
npm run playlist "late night rainy drive"
npm run playlist "upbeat gym workout"
npm run playlist "sunday morning coffee and chill"
npm run playlist "90s nostalgia"
npm run playlist "focus and concentration, no lyrics"
npm run playlist "high energy electronic, very danceable"
npm run playlist "sad acoustic, low energy"
```

**Cluster mode** — let AI discover themes in your library:
```bash
npm run cluster        # generates 5 playlists
npm run cluster 10     # generates 10 playlists
```

### Check your stats
```bash
npm run stats
```

---

## Output

Playlists are saved to the `playlists/` folder as `.m3u` files — open them in VLC, foobar2000, Swinsian, or any media player.

They're also stored in the database so you can query them later.

---

## Supported audio formats

MP3, FLAC, AAC, M4A, OGG, WAV, WavPack, APE, Opus

---

## MusicBrainz Picard tags

This project is optimized for libraries tagged with **MusicBrainz Picard**. Picard writes rich metadata that significantly improves playlist quality:

- Multiple genres per track
- Mood tags (`Happy`, `Not acoustic`, `Party`, `Not relaxed`, etc.)
- Full credits (producer, engineer, mixer, lyricist)
- MusicBrainz IDs for every track, album, and artist
- Accurate BPM, key, and release info

The more complete your Picard tags, the better the vibe matching. Combined with Essentia acoustic analysis, each track gets a comprehensive profile that covers both cultural context (genre, era, label) and sonic character (energy, danceability, acousticness).

---

## Choosing a chat model

Edit `CHAT_MODEL` in `src/playlist.ts`:

```ts
export const CHAT_MODEL = 'llama3.1:8b';
```

| Model | Size | Notes |
|---|---|---|
| `llama3.1:8b` | ~4.7GB | **Recommended.** Best playlist curation quality |
| `qwen2.5:7b` | ~4.4GB | Excellent JSON compliance, great for cluster mode |
| `llama3.2:3b` | ~2GB | Fast, good quality — best for lower-powered machines |
| `qwen2.5:3b` | ~2GB | Great structured output for smaller machines |
| `mistral` | ~4.4GB | Solid but llama3.1:8b is better |
| `gemma2:2b` | ~1.6GB | Lightweight option |

For **cluster mode** especially, 7B+ models produce dramatically better results than 3B models. The larger models reliably follow the "give me exactly N playlists" instruction where smaller ones tend to get lazy.

---

## Choosing an embedding model

Edit `EMBEDDING_MODEL` in `src/embedder.ts`:

```ts
export const EMBEDDING_MODEL = 'nomic-embed-text'; // default, 768 dims
```

| Model | Size | Dimensions | Notes |
|---|---|---|---|
| `nomic-embed-text` | ~274MB | 768 | **Default.** Fast and accurate |
| `mxbai-embed-large` | ~670MB | 1024 | Higher quality, slower |
| `all-minilm` | ~45MB | 384 | Very fast, lower quality |

> ⚠️ **If you switch embedding models** you must update the vector dimension in `src/db.ts` to match, wipe the database, and re-run the full pipeline.

```ts
// src/db.ts — update to match your chosen model's dimensions
embedding FLOAT[768]  // 768 for nomic, 1024 for mxbai-embed-large, 384 for all-minilm
```

---

## Resetting the database

To switch to a different music library or change embedding models:

```bash
rm data/library.db
npm run scan ~/Music
npm run analyze
npm run retext
npm run embed
```

The database is recreated automatically on the next scan. If you're just **adding new tracks** to an existing library you don't need to reset — run the full pipeline and each step will pick up only what's new or changed.

---

## Project structure

```
music-ai/
├── src/
│   ├── index.ts       CLI entry point
│   ├── db.ts          Database setup & schema
│   ├── scanner.ts     Music file scanning & metadata extraction
│   ├── embedder.ts    Vector embedding via Ollama
│   ├── retext.ts      Rebuilds metadata text with acoustic features
│   └── playlist.ts    Playlist generation (vibe + cluster)
├── analyze.py         Essentia acoustic feature extraction
├── data/
│   └── library.db     SQLite database (all metadata + vectors)
├── playlists/         Generated M3U files
└── package.json
```

---

## Troubleshooting

### `tsx: command not found`
Run `npm install` first — `tsx` is a local dev dependency that npm puts in `node_modules/.bin/`.

### `npm install` fails with C++20 errors on `better-sqlite3`
You're on Node v22 or v24. Downgrade to Node v20:
```bash
nvm install 20
nvm use 20
rm -rf node_modules
npm install
```

### `UPSERT not implemented for virtual table`
This is a `sqlite-vec` limitation. Fix in `src/embedder.ts` — replace the upsert with delete-then-insert:
```ts
const deleteVec = db.prepare(`DELETE FROM track_embeddings WHERE track_id = ?`);
const insertVec = db.prepare(`INSERT INTO track_embeddings (track_id, embedding) VALUES (?, ?)`);
```
And in the transaction:
```ts
const batchUpdate = db.transaction((id: number, vector: number[]) => {
  const vecBuffer = new Float32Array(vector);
  const intId = BigInt(id);
  deleteVec.run(intId);
  insertVec.run(intId, vecBuffer);
  markEmbedded.run(id);
});
```

### `Only integers are allowed for primary key values on track_embeddings`
The track ID needs to be cast to BigInt before passing to sqlite-vec. See the fix above — `BigInt(id)` in the transaction.

### `Embedded 0 tracks (N errors)`
Ollama isn't running or the model isn't pulled:
```bash
ollama list                      # should show nomic-embed-text
ollama pull nomic-embed-text     # pull if missing
```
Add temporary error logging to `src/embedder.ts` to see the actual error:
```ts
} catch (err) {
  errors++;
  if (errors <= 3) console.error(err);
}
```

### `~Infinity remaining` in embed progress
Harmless — divide-by-zero at the start before any tracks complete. Resolves automatically after the first 10 tracks.

### Cluster mode returns fewer playlists than requested
Smaller models (3B) struggle with large structured outputs. Switch to `llama3.1:8b` or `qwen2.5:7b` in `src/playlist.ts`. Also make sure the sample size isn't overwhelming the model — the default samples 100 tracks per cluster request.

### Essentia analysis errors on some files
Some files have unusual sample rates or encoding. The analyzer skips failed files (`analyzed = -1`) and continues. Run with the error flag visible:
```bash
python3 analyze.py --limit 20
```
Errors print inline so you can see which files are problematic.

### Playlist JSON parse errors
Some models don't reliably return valid JSON. Try `llama3.1:8b` or `qwen2.5:7b`. Log the raw output to debug:
```ts
const raw = await askOllama(aiPrompt);
console.log('\n--- Model output ---\n' + raw + '\n---\n');
```

### Essentia analysis is slow (under 1 track/second)
The analyzer uses all CPU cores by default. If it's still slow, check you're not reading from a slow source (USB flash drive, network mount). Copy your library to a local SSD first. You can also manually cap workers:
```bash
python3 analyze.py --workers 4
```

### `AudioLoader: Invalid frame, skipping it`
Harmless warning from Essentia about malformed frames in some files. The analysis still completes. Suppress it:
```bash
python3 analyze.py 2>/dev/null
```