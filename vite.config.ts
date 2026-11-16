import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const version = (
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

/** The commit being built: CI's `GITHUB_SHA`, else the checkout's HEAD, else `unknown`. */
function buildCommit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

// Emits version.json and stamps index.html with a content fingerprint so a running client can
// detect a newer deploy and offer a reload. Only `buildId` is compared; `commit` and `builtAt`
// are informational and keep the file readable when debugging a deploy.
function buildVersionPlugin(): Plugin {
  return {
    name: 'rogue-xr-build-version',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const hash = createHash('sha256').update(version).update('\0');
      for (const [path, entry] of Object.entries(bundle).sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (path.endsWith('.map')) continue;
        const bytes = entry.type === 'asset' ? entry.source : entry.code;
        hash.update(path).update('\0');
        hash.update(typeof bytes === 'string' ? bytes : new Uint8Array(bytes)).update('\0');
      }
      if (existsSync('public')) {
        for (const path of readdirSync('public', { encoding: 'utf8', recursive: true }).sort()) {
          if (!/\.[a-z0-9]+$/i.test(path)) continue;
          hash
            .update(path)
            .update('\0')
            .update(new Uint8Array(readFileSync(join('public', path))));
        }
      }
      const buildId = hash.digest('hex');
      const html = bundle['index.html'];
      if (html?.type !== 'asset') throw new Error('Build is missing index.html');
      html.source = html.source
        .toString()
        .replace('</head>', `<meta name="app-build" content="${buildId}"></head>`);
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({
          buildId,
          version,
          commit: buildCommit(),
          builtAt: new Date().toISOString(),
        }),
      });
    },
  };
}

/** Every SFX runtime file, so the unlinked audition page lists each one even when it has no spec. */
function sfxFileNames(): string[] {
  const dir = 'public/assets/audio/sfx';
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.ogg'))
        .sort()
    : [];
}

export default defineConfig({
  plugins: [buildVersionPlugin()],
  define: { __AUDITION_SFX_FILES__: JSON.stringify(sfxFileNames()) },
  server: { host: '0.0.0.0', port: 4260, strictPort: true },
  preview: { host: '0.0.0.0', port: 4261, strictPort: true },
  build: {
    target: 'es2023',
    sourcemap: true,
    // audition.html is a second entry that nothing links to: the owner reaches it by URL.
    rolldownOptions: { input: { main: 'index.html', audition: 'audition.html' } },
  },
});
