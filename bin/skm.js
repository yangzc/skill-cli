#!/usr/bin/env node
import { main } from '../src/commands.js';

// `skm ls | head` closes stdout early - that is normal, not a crash.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
