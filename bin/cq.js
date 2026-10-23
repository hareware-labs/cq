#!/usr/bin/env node
import { buildCli } from '../src/cli/index.js';

const program = buildCli();
try {
  await program.parseAsync(process.argv);
} catch (err) {
  console.error(`\x1b[31merror:\x1b[0m ${err?.message ?? err}`);
  if (process.env.CQ_DEBUG) console.error(err?.stack);
  process.exit(1);
}
