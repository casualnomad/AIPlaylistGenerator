# 🎵 music-ai

AI-powered playlist generator using your local music library, Ollama, and vector search. Fully offline. No cloud. No API keys.

## How it works

1. **Scan** — reads all metadata from every audio file including MusicBrainz Picard tags (mood, multiple genres, credits). Filters out non-musical folksonomy noise automatically.
2. **Analyze** — runs Essentia on every file using all CPU cores in parallel, extracting energy, valence, danceability, acousticness, instrumentalness, key, BPM, spectral character, and more directly from the audio waveform
3. **Lyrics** — fetches lyrics from LRCLib (free, no API key) for every track, stores raw lyrics and generates a concise LLM summary of theme, tone, and imagery
4. **Retext** — combines file tags + acoustic features + lyrics into a rich natural language description per track, including synthesized emotional arc and sound profile descriptions
5. **Embed** — converts each track's description into a vector using `nomic-embed-text` via Ollama
6. **Search** — when you describe a vibe, finds similar tracks via vector similarity
7. **Curate** — sends top candidates to a local LLM to make the final playlist
8. **Export** — saves as `.m3u` files your media player can open

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

> Essentia is the same audio analysis library that powered Spotify's Echo Nest. It extracts energy, valence, danceability, key, acousticness and more directly from the audio waveform — no metadata required.

### 3. Install Ollama
Download from [ollama.com](https://ollama.com) — it's a simple Mac app. Once installed, Ollama runs automatically in the background.

### 4. Pull the required models
```bash
ollama pull nomic-embed-text   # for embeddings (~274MB)
ollama pull llama3.1:8b        # for playlist curation (~4.7GB) — best quality
ollama pull llama3.2:3b        # for lyrics summarization (~2GB) — fast
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
Crawls your music folder, extracts all metadata from file tags including MusicBrainz Picard tags (mood, multiple genres, full credits). Automatically filters out non-musical MusicBrainz folksonomy tags like `Animal On Cover`, `Red On Cover`, `Skull On Cover` so they don't pollute the embeddings. Fast — typically seconds even for large libraries.

### Step 2 — Acoustic analysis
```bash
python3 analyze.py
```
Runs Essentia on every audio file using **all available CPU cores** in parallel. Extracts energy, valence, danceability, acousticness, instrumentalness, speechiness, loudness, BPM, key, spectral brightness, texture dynamism, and grit. On an M3 Mac expect around **2 tracks/second** — a 4000 track library takes roughly 35 minutes.

```bash
python3 analyze.py --limit 20 --verbose   # test on 20 tracks first
python3 analyze.py --all                  # re-analyze everything (overwrite existing)
python3 analyze.py --workers 4            # manually set worker count
```

> Run `python3 analyze.py` directly rather than via `npm run analyze` — npm doesn't pass arguments through to Python scripts cleanly.

### Step 3 — Fetch lyrics
```bash
npm run lyrics
```
Fetches lyrics from **LRCLib** (free, no API key, huge catalog) for every track using 5 concurrent requests. Stores both the raw lyrics (first 1000 chars) and a concise LLM-generated summary of theme, emotional tone, and imagery using `llama3.2:3b`. Instrumental tracks are detected and labeled automatically.

```bash
npm run lyrics -- --refetch       # re-fetch all tracks (overwrite existing)
npm run lyrics -- --limit=50      # only fetch N tracks
```

### Step 4 — Rebuild metadata text
```bash
npm run retext
```
Combines everything into a rich natural language description for each track — the actual text that gets embedded. Includes:

- File tag metadata (genre, mood, credits, label, era)
- Acoustic features described in natural language ("euphoric, joyful, uplifting" not just `valence: 0.87`)
- Spectral character: brightness, texture dynamism, grit/distortion
- Synthesized emotional arc ("aggressive, intense, dark energy — angry, powerful, confrontational")
- Synthesized sound profile ("acoustic instrumental — think classical, jazz, folk guitar, unplugged")
- Lyrical summary and raw lyrics excerpt

Also resets embedding status so Step 5 picks up all changes.

### Step 5 — Generate embeddings
```bash
npm run embed
```
Converts every track's metadata text into a vector. On Apple Silicon with `nomic-embed-text` expect around **35 tracks/second** — a 4000 track library takes roughly 2 minutes. Only runs on tracks that haven't been embedded yet (or were reset by `retext`).

### Step 6 — Generate playlists!

**Vibe mode** — describe what you want:
```bash
npm run playlist "late night rainy drive"
npm run playlist "upbeat gym workout"
npm run playlist "sunday morning coffee and chill"
npm run playlist "90s nostalgia"
npm run playlist "focus and concentration, no lyrics"
npm run playlist "high energy electronic, very danceable"
npm run playlist "sad acoustic, introspective lyrics"
npm run playlist "aggressive minor key, dark energy"
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

The scanner automatically filters out MusicBrainz folksonomy noise — tags describing artwork (`Animal On Cover`, `Skull On Cover`), colors (`Red On Cover`), and packaging descriptors that pollute genre matching. Only musically meaningful genres make it through.

The more complete your Picard tags, the better the vibe matching. Combined with Essentia acoustic analysis and LRCLib lyrics, each track gets a comprehensive profile covering cultural context, sonic character, and lyrical content.

---

## Choosing a chat model

Two models are used: one for **playlist curation** (needs to be smart, good at JSON), one for **lyrics summarization** (needs to be fast).

### Playlist curation model
Edit `CHAT_MODEL` in `src/playlist.ts`:

```ts
export const CHAT_MODEL = 'llama3.1:8b';
```

| Model | Size | Notes |
|---|---|---|
| `llama3.1:8b` | ~4.7GB | **Recommended.** Best curation quality, reliable JSON |
| `qwen2.5:7b` | ~4.4GB | Excellent JSON compliance, great for cluster mode |
| `llama3.2:3b` | ~2GB | Fast, good quality — best for lower-powered machines |
| `qwen2.5:3b` | ~2GB | Great structured output for smaller machines |
| `mistral` | ~4.4GB | Solid but llama3.1:8b is better |

For **cluster mode** especially, 7B+ models produce dramatically better results — smaller models tend to return fewer playlists than requested and with fewer tracks.

### Lyrics summarization model
Edit `SUMMARY_MODEL` in `src/lyrics.ts`:

```ts
const SUMMARY_MODEL = 'llama3.2:3b';
```

The 3B model is fast enough for this task and produces good summaries. No need to use the larger model here.

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
npm run lyrics
npm run retext
npm run embed
```

The database is recreated automatically on the next scan. If you're just **adding new tracks** to an existing library, you don't need to reset — run the full pipeline and each step picks up only what's new or changed.

---

## Project structure

```
music-ai/
├── src/
│   ├── index.ts       CLI entry point
│   ├── db.ts          Database setup & schema
│   ├── scanner.ts     Music file scanning, metadata extraction & genre filtering
│   ├── embedder.ts    Vector embedding via Ollama
│   ├── retext.ts      Rebuilds metadata text with acoustic + lyrical features
│   ├── lyrics.ts      LRCLib fetch + LLM summarization
│   └── playlist.ts    Playlist generation (vibe + cluster)
├── analyze.py         Parallel Essentia acoustic feature extraction
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
Smaller models (3B) struggle with large structured outputs. Switch to `llama3.1:8b` or `qwen2.5:7b` in `src/playlist.ts`.

### Lyrics not being fetched
LRCLib can be slow — the default timeout is 30 seconds. If you're on a slow connection increase it in `src/lyrics.ts`:
```ts
signal: AbortSignal.timeout(60000),
```
Also check LRCLib is reachable:
```bash
curl "https://lrclib.net/api/get?track_name=Attaboy&artist_name=Aesop+Rock"
```

### Weird genres like `Animal On Cover` or `Red On Cover`
These are MusicBrainz folksonomy tags. The scanner filters them automatically via `GENRE_BLOCKLIST` in `scanner.ts`. If you see others slipping through, add them to the regex. Then rescan:
```bash
npm run scan ~/Music
npm run retext
npm run embed
```

### Essentia analysis is slow (under 1 track/second)
Check you're not reading from a slow source (USB flash drive, network mount). Copy your library to a local SSD first. You can also manually cap workers:
```bash
python3 analyze.py --workers 4
```

### `AudioLoader: Invalid frame, skipping it`
Harmless warning from Essentia about malformed frames in some files. The analysis still completes. Suppress it:
```bash
python3 analyze.py 2>/dev/null
```

### Essentia analysis errors on some files
Some files have unusual encoding. The analyzer marks them `analyzed = -1` and continues. See which files failed:
```bash
python3 analyze.py --limit 20 --verbose
```

### Playlist JSON parse errors
Some models don't reliably return valid JSON. Try `llama3.1:8b` or `qwen2.5:7b`. Log the raw output to debug by adding this after the `askOllama` call in `src/playlist.ts`:
```ts
console.log('\n--- Model output ---\n' + raw + '\n---\n');
```