import { Ollama } from 'ollama';
import chalk from 'chalk';
import ora from 'ora';
import type Database from 'better-sqlite3';

const ollama = new Ollama({ host: 'http://localhost:11434' });

// nomic-embed-text produces 768-dimensional vectors and is fast + accurate
export const EMBEDDING_MODEL = 'nomic-embed-text';

interface TrackRow {
  id: number;
  metadata_text: string;
}

async function embedText(text: string): Promise<number[]> {
  const response = await ollama.embeddings({
    model: EMBEDDING_MODEL,
    prompt: text,
  });
  return response.embedding;
}

export async function embedLibrary(db: Database.Database): Promise<void> {
  // Check Ollama is running
  try {
    await ollama.list();
  } catch {
    console.error(chalk.red('❌ Cannot connect to Ollama. Is it running? Try: ollama serve'));
    process.exit(1);
  }

  // Check model is available
  const models = await ollama.list();
  const hasEmbedModel = models.models.some(m => m.name.startsWith(EMBEDDING_MODEL));
  if (!hasEmbedModel) {
    console.log(chalk.yellow(`⬇️  Pulling ${EMBEDDING_MODEL}...`));
    await ollama.pull({ model: EMBEDDING_MODEL, stream: false });
  }

  // Get all tracks that haven't been embedded yet
  const pending = db.prepare(`
    SELECT id, metadata_text FROM tracks WHERE embedded = 0 ORDER BY id
  `).all() as TrackRow[];

  if (pending.length === 0) {
    console.log(chalk.green('✅ All tracks already embedded!'));
    return;
  }

  console.log(chalk.cyan(`\n🔢 Embedding ${pending.length} tracks...\n`));
  console.log(chalk.gray('This only runs once per track. Grab a coffee ☕\n'));

  const deleteVec = db.prepare(`DELETE FROM track_embeddings WHERE track_id = ?`);
  const insertVec = db.prepare(`INSERT INTO track_embeddings (track_id, embedding) VALUES (?, ?)`);

  const markEmbedded = db.prepare(`
    UPDATE tracks SET embedded = 1, embedded_at = unixepoch() WHERE id = ?
  `);

  const batchUpdate = db.transaction((id: number, vector: number[]) => {
    const vecBuffer = new Float32Array(vector);
    const intId = BigInt(id);
    deleteVec.run(intId);
    insertVec.run(intId, vecBuffer);
    markEmbedded.run(id);
  });

  let done = 0;
  let errors = 0;
  const spinner = ora(`0/${pending.length}`).start();
  const startTime = Date.now();

  for (const track of pending) {
    try {
      const vector = await embedText(track.metadata_text);
      batchUpdate(track.id, vector);
      done++;
    } catch (err) {
      errors++;
      if (errors <= 3) console.error(err);
    }

    if (done % 10 === 0 || done === pending.length) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = done / elapsed;
      const remaining = (pending.length - done) / rate;
      spinner.text = `${done}/${pending.length} — ${rate.toFixed(1)}/s — ~${Math.round(remaining)}s remaining`;
    }
  }

  spinner.succeed(
    `Embedded ${chalk.green(done)} tracks` +
    (errors > 0 ? chalk.yellow(` (${errors} errors)`) : '')
  );
}

/**
 * Embed a search query and find the most similar tracks.
 * Returns track IDs sorted by similarity.
 */
export async function searchSimilar(
  db: Database.Database,
  query: string,
  limit: number = 50
): Promise<number[]> {
  const queryVector = await embedText(query);
  const vecBuffer = new Float32Array(queryVector);

  const results = db.prepare(`
    SELECT track_id, distance
    FROM track_embeddings
    WHERE embedding MATCH ?
    AND k = ?
    ORDER BY distance
  `).all(vecBuffer, limit) as { track_id: number; distance: number }[];

  return results.map(r => r.track_id);
}
