#!/usr/bin/env node
import { main } from '../lib/cli.js';

// A consumer such as head may close a pipe early. Do not emit an uncaught stack
// trace or fall back to printing the value to a different stream.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', error => process.exit(error.code === 'EPIPE' ? 0 : 1));
}

process.exitCode = await main(process.argv.slice(2));
