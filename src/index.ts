import chalk from 'chalk';
import { getDb, initDb } from './db.js';
import { scanLibrary } from './scanner.js';
import { embedLibrary } from './embedder.js';
import { generateVibePlaylist, generateClusters } from './playlist.js';
import { retextLibrary } from './retext.js';

const COMMANDS = ['scan', 'embed', 'playlist', 'cluster', 'retext', 'stats'] as const;
type Command = typeof COMMANDS[number];

function printHelp() {
  console.log(`
${chalk.bold.cyan('🎵 music-ai')} — AI-powered playlist generator

${chalk.bold('Usage:')}
  npm run scan      [music_dir]   Scan music folder and extract metadata
  npm run embed                   Generate embeddings for all unembedded tracks
  npm run retext                  Rebuild metadata text with acoustic features
  npm run playlist  "your vibe"   Generate a playlist from a description
  npm run cluster   [count]       Auto-generate themed playlists (default: 5)
  npm run stats                   Show library statistics

${chalk.bold('Examples:')}
  npm run scan ~/Music
  npm run embed
  npm run playlist "late night rainy drive"
  npm run playlist "upbeat workout energy"
  npm run cluster 8
  `);
}

function printStats(db: ReturnType<typeof getDb>) {
  const total    = (db.prepare('SELECT COUNT(*) as n FROM tracks').get() as { n: number }).n;
  const embedded = (db.prepare('SELECT COUNT(*) as n FROM tracks WHERE embedded = 1').get() as { n: number }).n;
  const playlists = (db.prepare('SELECT COUNT(*) as n FROM playlists').get() as { n: number }).n;

  const genres = db.prepare(`
    SELECT genre, COUNT(*) as count FROM tracks
    WHERE genre IS NOT NULL
    GROUP BY genre ORDER BY count DESC LIMIT 10
  `).all() as { genre: string; count: number }[];

  const artists = db.prepare(`
    SELECT artist, COUNT(*) as count FROM tracks
    WHERE artist IS NOT NULL
    GROUP BY artist ORDER BY count DESC LIMIT 10
  `).all() as { artist: string; count: number }[];

  console.log(`
${chalk.bold.cyan('📚 Library Stats')}

  Total tracks:     ${chalk.green(total)}
  Embedded:         ${chalk.green(embedded)} ${embedded < total ? chalk.yellow(`(${total - embedded} pending)`) : ''}
  Playlists saved:  ${chalk.green(playlists)}

${chalk.bold('Top Genres:')}
${genres.map(g => `  ${g.genre.padEnd(25)} ${g.count}`).join('\n')}

${chalk.bold('Top Artists:')}
${artists.map(a => `  ${a.artist.padEnd(25)} ${a.count}`).join('\n')}
  `);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] as Command;

  if (!command || !COMMANDS.includes(command)) {
    printHelp();
    process.exit(0);
  }

  const db = getDb();
  initDb(db);

  switch (command) {
    case 'scan': {
      const musicDir = args[1] ?? process.env.MUSIC_DIR;
      if (!musicDir) {
        console.error(chalk.red('Please provide your music directory:'));
        console.error(chalk.gray('  npm run scan ~/Music'));
        process.exit(1);
      }
      await scanLibrary(db, musicDir);
      break;
    }

    case 'embed': {
      await embedLibrary(db);
      break;
    }

    case 'playlist': {
      const prompt = args.slice(1).join(' ');
      if (!prompt) {
        console.error(chalk.red('Please provide a vibe description:'));
        console.error(chalk.gray('  npm run playlist "late night rainy drive"'));
        process.exit(1);
      }
      await generateVibePlaylist(db, prompt);
      break;
    }

    case 'cluster': {
      const count = parseInt(args[1] ?? '5', 10);
      await generateClusters(db, count);
      break;
    }

    case 'stats': {
      printStats(db);
      break;
    }

    case 'retext': {
      await retextLibrary(db);
      break;
  }
  }

  db.close();
}

main().catch(err => {
  console.error(chalk.red('Fatal error:'), err);
  process.exit(1);
});
