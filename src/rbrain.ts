#!/usr/bin/env bun

/**
 * RBrain is the Feishu-first entrypoint for this fork.
 *
 * It deliberately reuses the mature GBrain engine underneath while giving the
 * user's Feishu brain its own home directory and schema defaults.
 */
process.env.RBRAIN_MODE = '1';

if (!process.env.GBRAIN_SCHEMA_PACK) {
  process.env.GBRAIN_SCHEMA_PACK = 'rbrain-feishu';
}

const command = process.argv[2];
const hasSchemaPack = process.argv.includes('--schema-pack');
if (command === 'init' && !hasSchemaPack) {
  process.argv.push('--schema-pack', 'rbrain-feishu');
}

await import('./cli.ts');

export {};
