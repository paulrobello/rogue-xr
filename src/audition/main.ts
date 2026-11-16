import prompts from '../../assets-source/audio/sfx/prompts.json';
import './style.css';
import { cuesDocument, sfxFiles } from './cues-source.ts';
import { AuditionEngine } from './engine.ts';
import {
  type AuditionItem,
  buildMusicItems,
  buildSfxItems,
  parseCues,
  type ReportEntry,
} from './items.ts';
import { loadState } from './review.ts';
import { AuditionApp } from './ui.ts';

const CUES_PATH = 'assets-source/audio/music/cues.json';

async function fetchReport(): Promise<Record<string, ReportEntry> | null> {
  try {
    const response = await fetch('assets/audio/report.json');
    if (!response.ok) return null;
    const body = (await response.json()) as { sfx?: Record<string, ReportEntry> };
    return body.sfx ?? null;
  } catch {
    return null;
  }
}

/** True when the URL answers with an audio file, not the dev server's HTML fallback. */
async function audioExists(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    const type = response.headers.get('content-type') ?? '';
    return response.ok && !type.includes('text/html');
  } catch {
    return false;
  }
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) return;
  const report = await fetchReport();
  const cues = parseCues(cuesDocument);
  const musicItems = buildMusicItems(cues);
  const present = await Promise.all(
    musicItems.map((item) => (item.url ? audioExists(item.url) : false)),
  );
  const music: AuditionItem[] = musicItems.filter((_, i) => present[i]);
  const pendingMusic: AuditionItem[] = musicItems.filter((_, i) => !present[i]);

  const engine = new AuditionEngine();
  engine.onStatus = (status) => {
    document.documentElement.dataset.audioState = status;
  };
  document.documentElement.dataset.audioState = engine.status;

  const app = new AuditionApp({
    engine,
    sfx: buildSfxItems(sfxFiles, prompts.cues, report),
    music,
    pendingMusic,
    state: loadState(storage()),
    storage: storage(),
    cuesPath: CUES_PATH,
    musicListed: cues.length > 0,
  });
  app.mount(root);
  document.documentElement.dataset.ready = 'true';
}

void main();
