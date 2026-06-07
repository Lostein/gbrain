// Bundled schema-pack registry.
//
// Bun's text imports are embedded into `bun build --compile` binaries, so the
// CLI can still load canonical packs when the source-tree YAML files are not
// present next to the executable.

import gbrainBase from './base/gbrain-base.yaml' with { type: 'text' };
import gbrainRecommended from './base/gbrain-recommended.yaml' with { type: 'text' };
import gbrainCreator from './base/gbrain-creator.yaml' with { type: 'text' };
import gbrainInvestor from './base/gbrain-investor.yaml' with { type: 'text' };
import gbrainEngineer from './base/gbrain-engineer.yaml' with { type: 'text' };
import gbrainEverything from './base/gbrain-everything.yaml' with { type: 'text' };
import gbrainBaseV2 from './base/gbrain-base-v2.yaml' with { type: 'text' };
import rbrainFeishu from './base/rbrain-feishu.yaml' with { type: 'text' };

export const BUNDLED_SCHEMA_PACK_NAMES = [
  'gbrain-base',
  'gbrain-recommended',
  'gbrain-creator',
  'gbrain-investor',
  'gbrain-engineer',
  'gbrain-everything',
  'gbrain-base-v2',
  'rbrain-feishu',
] as const;

export type BundledSchemaPackName = typeof BUNDLED_SCHEMA_PACK_NAMES[number];

const BUNDLED_SCHEMA_PACK_NAME_SET = new Set<string>(BUNDLED_SCHEMA_PACK_NAMES);

const BUNDLED_SCHEMA_PACK_CONTENT: Record<BundledSchemaPackName, string> = {
  'gbrain-base': gbrainBase,
  'gbrain-recommended': gbrainRecommended,
  'gbrain-creator': gbrainCreator,
  'gbrain-investor': gbrainInvestor,
  'gbrain-engineer': gbrainEngineer,
  'gbrain-everything': gbrainEverything,
  'gbrain-base-v2': gbrainBaseV2,
  'rbrain-feishu': rbrainFeishu,
};

export function isBundledSchemaPackName(name: string): name is BundledSchemaPackName {
  return BUNDLED_SCHEMA_PACK_NAME_SET.has(name);
}

export function getBundledSchemaPackContent(name: string): string | null {
  return isBundledSchemaPackName(name) ? BUNDLED_SCHEMA_PACK_CONTENT[name] : null;
}

export function bundledSchemaPackVirtualPath(name: string): string {
  return `bundled://schema-pack/${name}.yaml`;
}
