#!/usr/bin/env node
// The `parallax` command: runs the TypeScript sources through tsx (no build step).
import process from 'node:process';
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/cli.ts');
process.exitCode = await main(process.argv.slice(2));
