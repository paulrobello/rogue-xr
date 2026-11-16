// @vitest-environment node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const pub = new URL('public/', root);
const SITE = 'https://spire.pardev.net/';

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}
interface Manifest {
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: string;
  display_override?: string[];
  background_color: string;
  theme_color: string;
  categories: string[];
  icons: ManifestIcon[];
}

/** Width, height and colour type from a PNG IHDR chunk. */
function pngHeader(bytes: Buffer): { width: number; height: number; colorType: number } {
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes.readUInt8(25),
  };
}

function publicFile(src: string): URL {
  return new URL(src.replace(/^\//, ''), pub);
}

const html = readFileSync(new URL('index.html', root), 'utf8');
const head = html.slice(0, html.indexOf('</head>'));

/** content of <meta name|property="key">, attribute order and line breaks tolerated. */
function meta(key: string): string | undefined {
  for (const tag of head.match(/<meta\b[^>]*>/g) ?? []) {
    const id = /\b(?:name|property)="([^"]+)"/.exec(tag)?.[1];
    if (id === key) return /\bcontent="([^"]*)"/.exec(tag)?.[1];
  }
  return undefined;
}

function link(rel: string): string[] {
  return (head.match(/<link\b[^>]*>/g) ?? [])
    .filter((tag) => new RegExp(`\\brel="${rel}"`).test(tag))
    .map((tag) => /\bhref="([^"]+)"/.exec(tag)?.[1] ?? '');
}

describe('PWA manifest', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('manifest.webmanifest', pub), 'utf8'),
  ) as Manifest;

  it('describes the game', () => {
    expect(manifest.name).toBe('Clockwork Spire');
    expect(manifest.short_name.length).toBeGreaterThan(0);
    expect(manifest.description.length).toBeGreaterThan(20);
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('fullscreen');
    expect(manifest.display_override).toContain('fullscreen');
    expect(manifest.categories).toEqual(['games']);
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('lists icons that exist at their declared size', () => {
    expect(manifest.icons.length).toBeGreaterThanOrEqual(4);
    for (const icon of manifest.icons) {
      const file = publicFile(icon.src);
      expect(existsSync(file), icon.src).toBe(true);
      if (icon.type !== 'image/png') continue;
      const { width, height } = pngHeader(readFileSync(file));
      expect(`${width}x${height}`, icon.src).toBe(icon.sizes);
    }
  });

  it('has an opaque 512 px maskable icon', () => {
    const maskable = manifest.icons.filter((icon) => icon.purpose === 'maskable');
    expect(maskable).toHaveLength(1);
    const header = pngHeader(readFileSync(publicFile(maskable[0]?.src ?? '')));
    expect([header.width, header.height]).toEqual([512, 512]);
    expect(header.colorType).toBe(2);
  });
});

describe('favicons and touch icon', () => {
  it('ships every favicon file', () => {
    for (const name of [
      'favicon.svg',
      'favicon.ico',
      'favicon-96x96.png',
      'apple-touch-icon.png',
    ]) {
      expect(existsSync(new URL(name, pub)), name).toBe(true);
    }
    expect(readFileSync(new URL('favicon.svg', pub), 'utf8')).toContain('<svg');
  });

  it('packs 16, 32 and 48 px frames into favicon.ico', () => {
    const ico = readFileSync(new URL('favicon.ico', pub));
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, i) => ico.readUInt8(6 + i * 16) || 256).sort(
      (a, b) => a - b,
    );
    expect(sizes).toEqual([16, 32, 48]);
  });

  it('has a 96 px favicon and an opaque 180 px apple-touch icon', () => {
    const fav = pngHeader(readFileSync(new URL('favicon-96x96.png', pub)));
    expect([fav.width, fav.height]).toEqual([96, 96]);
    const touch = pngHeader(readFileSync(new URL('apple-touch-icon.png', pub)));
    expect([touch.width, touch.height]).toEqual([180, 180]);
    expect(touch.colorType).toBe(2);
  });
});

describe('share image', () => {
  it('is a 1200x630 PNG under 600 KB', () => {
    const file = new URL('og-image.png', pub);
    const { width, height } = pngHeader(readFileSync(file));
    expect([width, height]).toEqual([1200, 630]);
    expect(statSync(file).size).toBeLessThan(600 * 1024);
  });
});

describe('index.html head', () => {
  it('carries title, description, canonical and app tags', () => {
    expect(head).toMatch(/<title>[^<]*Clockwork Spire[^<]*<\/title>/);
    const description = meta('description') ?? '';
    expect(description.length).toBeGreaterThanOrEqual(120);
    expect(description.length).toBeLessThanOrEqual(165);
    expect(link('canonical')).toEqual([SITE]);
    expect(meta('robots')).toBe('index, follow');
    expect(meta('author')).toBe('Paul Robello');
    expect(meta('color-scheme')).toBe('dark');
    expect(meta('theme-color')).toMatch(/^#[0-9a-f]{6}$/i);
    expect(meta('mobile-web-app-capable')).toBe('yes');
    expect(meta('apple-mobile-web-app-capable')).toBe('yes');
    expect(meta('apple-mobile-web-app-title')).toBeTruthy();
    expect(meta('apple-mobile-web-app-status-bar-style')).toBeTruthy();
  });

  it('links the manifest and every icon', () => {
    expect(link('manifest')).toEqual(['/manifest.webmanifest']);
    expect(link('icon').sort()).toEqual(['/favicon-96x96.png', '/favicon.ico', '/favicon.svg']);
    expect(link('apple-touch-icon')).toEqual(['/apple-touch-icon.png']);
    for (const href of [...link('icon'), ...link('apple-touch-icon'), ...link('manifest')]) {
      expect(existsSync(publicFile(href)), href).toBe(true);
    }
  });

  it('has the full Open Graph set with an absolute image', () => {
    expect(meta('og:type')).toBe('website');
    expect(meta('og:site_name')).toBe('Clockwork Spire');
    expect(meta('og:title')).toBeTruthy();
    expect(meta('og:description')).toBeTruthy();
    expect(meta('og:url')).toBe(SITE);
    expect(meta('og:image')).toBe(`${SITE}og-image.png`);
    expect(meta('og:image:width')).toBe('1200');
    expect(meta('og:image:height')).toBe('630');
    expect(meta('og:image:alt')).toBeTruthy();
    expect(meta('og:locale')).toBe('en_US');
  });

  it('has Twitter large-image card tags', () => {
    expect(meta('twitter:card')).toBe('summary_large_image');
    expect(meta('twitter:title')).toBeTruthy();
    expect(meta('twitter:description')).toBeTruthy();
    expect(meta('twitter:image')).toBe(`${SITE}og-image.png`);
    expect(meta('twitter:image:alt')).toBeTruthy();
  });

  it('has parseable VideoGame JSON-LD', () => {
    const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(head)?.[1];
    expect(block).toBeTruthy();
    const data = JSON.parse(block ?? '') as Record<string, unknown>;
    expect(data['@type']).toBe('VideoGame');
    expect(data.name).toBe('Clockwork Spire');
    expect(data.url).toBe(SITE);
    expect(data.gamePlatform).toEqual(['Meta Quest 3 (WebXR)', 'Web browser']);
    expect(data.author).toMatchObject({ '@type': 'Person', name: 'Paul Robello' });
    expect(data.offers).toMatchObject({ '@type': 'Offer', price: '0' });
  });
});

describe('robots and sitemap', () => {
  it('allows crawling and points at the sitemap', () => {
    const robots = readFileSync(new URL('robots.txt', pub), 'utf8');
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).toMatch(/^Allow: \/$/m);
    expect(robots).toContain(`Sitemap: ${SITE}sitemap.xml`);
  });

  it('lists the site root', () => {
    const sitemap = readFileSync(new URL('sitemap.xml', pub), 'utf8');
    expect(sitemap).toContain('http://www.sitemaps.org/schemas/sitemap/0.9');
    expect(sitemap).toContain(`<loc>${SITE}</loc>`);
  });
});
