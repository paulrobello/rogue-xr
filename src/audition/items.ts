export interface MeasuredLoudness {
  integrated_lufs?: number;
  true_peak_dbtp?: number;
  momentary_max_lufs?: number;
}

export interface ReportEntry {
  measured?: MeasuredLoudness;
  decoded_duration_s?: number;
  loudness_status?: string;
  limited_by_true_peak?: boolean;
  short_clip_lufs_unreliable?: boolean;
  opus_kbps?: number;
}

export interface SfxPrompt {
  id: string;
  class?: string;
  duration_seconds?: number;
  prompt_influence?: number;
  loop?: boolean;
  text?: string;
}

export interface MusicCue {
  order?: number;
  id: string;
  title?: string;
  when?: string;
  loop?: boolean;
  sourceFile?: string;
  runtimeFile?: string;
  prompt?: string;
  settings?: unknown;
  measured?: MeasuredLoudness;
}

export interface Fact {
  label: string;
  value: string;
}

export interface AuditionItem {
  /** Storage key: `sfx:<id>` or `music:<id>`. */
  key: string;
  kind: 'sfx' | 'music';
  id: string;
  title: string;
  /** Where or when the game plays it. */
  when: string | null;
  loop: boolean;
  /** URL relative to the audition page, or null when no file is named. */
  url: string | null;
  prompt: string | null;
  facts: Fact[];
  /** Duration known before decoding, in seconds. */
  durationS: number | null;
  /** Measured integrated loudness, or null when the page must estimate it. */
  lufs: number | null;
  /** A warning about the measurement, shown beside the facts. */
  caveat: string | null;
}

const SFX_DIR = 'assets/audio/sfx/';

const fmt = (value: number | undefined, digits: number, unit: string): string | null =>
  typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(digits)} ${unit}`.trim()
    : null;

function pushFact(facts: Fact[], label: string, value: string | null | undefined): void {
  if (value) facts.push({ label, value });
}

const KIND_LABEL: Record<string, string> = {
  ui: 'UI cue, stereo, flat',
  positional: 'Positional cue, mono, spatialised',
};

/** One item per prompt id and per file, so a file with no spec and a spec with no file both show. */
export function buildSfxItems(
  files: readonly string[],
  prompts: readonly SfxPrompt[],
  report: Record<string, ReportEntry> | null,
): AuditionItem[] {
  const byId = new Map(prompts.map((p) => [p.id, p]));
  const fileIds = new Set(
    files.filter((f) => f.endsWith('.ogg')).map((f) => f.replace(/\.ogg$/, '')),
  );
  const ids = [...new Set([...prompts.map((p) => p.id), ...fileIds])];
  return ids.map((id) => {
    const spec = byId.get(id);
    const entry = report?.[id];
    const measured = entry?.measured;
    const facts: Fact[] = [];
    pushFact(facts, 'Game cue', id);
    pushFact(facts, 'Kind', spec?.class ? (KIND_LABEL[spec.class] ?? spec.class) : null);
    pushFact(facts, 'Requested length', fmt(spec?.duration_seconds, 2, 's'));
    pushFact(facts, 'Loudness', fmt(measured?.integrated_lufs, 1, 'LUFS'));
    pushFact(facts, 'Momentary max', fmt(measured?.momentary_max_lufs, 1, 'LUFS'));
    pushFact(facts, 'True peak', fmt(measured?.true_peak_dbtp, 1, 'dBTP'));
    pushFact(facts, 'Prompt influence', fmt(spec?.prompt_influence, 1, ''));
    pushFact(facts, 'Encoding', entry?.opus_kbps ? `Opus ${entry.opus_kbps} kbps` : null);
    let caveat: string | null = null;
    if (entry?.loudness_status === 'deviation') {
      caveat = entry.limited_by_true_peak
        ? 'Quieter than the -16 LUFS target: a full-scale peak over a quiet body stopped the gain.'
        : 'Misses the -16 LUFS target.';
    }
    if (entry?.short_clip_lufs_unreliable) {
      caveat = `${caveat ? `${caveat} ` : ''}Under one second, so the loudness is a single gated block.`;
    }
    return {
      key: `sfx:${id}`,
      kind: 'sfx' as const,
      id,
      title: id,
      when: null,
      loop: spec?.loop === true,
      url: fileIds.has(id) ? `${SFX_DIR}${id}.ogg` : null,
      prompt: spec?.text ?? null,
      facts,
      durationS: entry?.decoded_duration_s ?? spec?.duration_seconds ?? null,
      lufs: measured?.integrated_lufs ?? null,
      caveat,
    };
  });
}

/** Cues from `cues.json`, ordered by `order` (file order breaks ties). Malformed entries are dropped. */
export function parseCues(doc: unknown): MusicCue[] {
  const list = (doc as { cues?: unknown } | null)?.cues;
  if (!Array.isArray(list)) return [];
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const cues: MusicCue[] = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== 'string' || c.id === '') continue;
    cues.push({
      order: typeof c.order === 'number' ? c.order : undefined,
      id: c.id,
      title: str(c.title),
      when: str(c.when),
      loop: typeof c.loop === 'boolean' ? c.loop : undefined,
      sourceFile: str(c.sourceFile),
      runtimeFile: str(c.runtimeFile),
      prompt: str(c.prompt),
      settings: c.settings,
      measured:
        typeof c.measured === 'object' && c.measured !== null
          ? (c.measured as MeasuredLoudness)
          : undefined,
    });
  }
  const rank = (cue: MusicCue): number => cue.order ?? Number.MAX_SAFE_INTEGER;
  return cues
    .map((cue, index) => ({ cue, index }))
    .sort((a, b) => rank(a.cue) - rank(b.cue) || a.index - b.index)
    .map(({ cue }) => cue);
}

/** `public/assets/audio/music/x.ogg` and `/assets/...` both become a URL relative to the page. */
export function publicUrl(runtimeFile: string): string {
  return runtimeFile.replace(/^\/?(public\/)?/, '');
}

function settingsFacts(settings: unknown): Fact[] {
  if (typeof settings === 'string' && settings) return [{ label: 'Settings', value: settings }];
  if (typeof settings !== 'object' || settings === null) return [];
  return Object.entries(settings as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([label, v]) => ({ label, value: typeof v === 'object' ? JSON.stringify(v) : String(v) }));
}

export function buildMusicItems(cues: readonly MusicCue[]): AuditionItem[] {
  return cues.map((cue) => {
    const facts: Fact[] = [];
    pushFact(facts, 'Game cue', cue.id);
    pushFact(facts, 'Source', cue.sourceFile);
    pushFact(facts, 'Runtime file', cue.runtimeFile);
    facts.push(...settingsFacts(cue.settings));
    pushFact(facts, 'Loudness', fmt(cue.measured?.integrated_lufs, 1, 'LUFS'));
    pushFact(facts, 'True peak', fmt(cue.measured?.true_peak_dbtp, 1, 'dBTP'));
    return {
      key: `music:${cue.id}`,
      kind: 'music' as const,
      id: cue.id,
      title: cue.title ?? cue.id,
      when: cue.when ?? null,
      loop: cue.loop === true,
      url: cue.runtimeFile ? publicUrl(cue.runtimeFile) : null,
      prompt: cue.prompt ?? null,
      facts,
      durationS: null,
      lufs: cue.measured?.integrated_lufs ?? null,
      caveat: null,
    };
  });
}
