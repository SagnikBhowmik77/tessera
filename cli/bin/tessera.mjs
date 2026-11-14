#!/usr/bin/env node
import { CliError, main } from '../tessera.mjs';

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof CliError ? `tessera: ${err.message}` : err);
  process.exit(1);
});
