import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { stageWorkspaceAssets } from '@par/xr-workspace/stage-assets';

await stageWorkspaceAssets('public');

// KTX2 transcoder, self-hosted so production builds never reach into node_modules.
const basisSource = join('node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');
const basisTarget = join('public', 'vendor', 'basis');
await mkdir(basisTarget, { recursive: true });
for (const file of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
  await copyFile(join(basisSource, file), join(basisTarget, file));
}
