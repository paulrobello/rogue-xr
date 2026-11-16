import type { AuditionEngine, Clip } from './engine.ts';
import type { AuditionItem } from './items.ts';
import { matchGain, REVIEW_LUFS } from './loudness.ts';
import {
  exportReview,
  type ReviewState,
  type StorageLike,
  saveState,
  type Verdict,
} from './review.ts';

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="1"/></svg>',
  loop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H19m0 0-3-3m3 3-3 3M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H5m0 0 3 3m-3-3 3-3"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
  cross: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  match:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6M8 6v12M12 9v6M16 4v16M20 9v6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="1.5"/><path d="M5 16V5.5A1.5 1.5 0 0 1 6.5 4H15"/></svg>',
} as const;

type IconName = keyof typeof ICONS;
type FilterName = 'all' | 'unreviewed' | 'approve' | 'reject';

const FILTERS: ReadonlyArray<readonly [FilterName, string]> = [
  ['all', 'All'],
  ['unreviewed', 'Not reviewed'],
  ['approve', 'Approved'],
  ['reject', 'Rejected'],
];

const VERDICT_TEXT: Record<Verdict, string> = { approve: 'Approved', reject: 'Rejected' };

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; attrs?: Record<string, string> } = {},
  children: Array<Node | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  for (const child of children) if (child) node.append(child);
  return node;
}

function icon(name: IconName): HTMLSpanElement {
  const span = el('span', { class: 'icon' });
  span.innerHTML = ICONS[name];
  return span;
}

function button(
  label: string,
  iconName: IconName | null,
  cls: string,
  attrs: Record<string, string> = {},
): HTMLButtonElement {
  return el('button', { class: cls, attrs: { type: 'button', ...attrs } }, [
    iconName ? icon(iconName) : null,
    el('span', { class: 'label', text: label }),
  ]);
}

const seconds = (value: number | null): string => (value === null ? '--' : `${value.toFixed(2)} s`);

interface Plate {
  item: AuditionItem;
  root: HTMLElement;
  play: HTMLButtonElement;
  badge: HTMLElement;
  canvas: HTMLCanvasElement;
  hint: HTMLElement;
  playhead: HTMLElement;
  meterMask: HTMLElement;
  time: HTMLElement;
  gainNote: HTMLElement;
  loopToggle: HTMLButtonElement | null;
  approve: HTMLButtonElement | null;
  reject: HTMLButtonElement | null;
  note: HTMLInputElement | null;
  clip: Clip | null;
  loop: boolean;
}

export interface AppOptions {
  engine: AuditionEngine;
  sfx: AuditionItem[];
  music: AuditionItem[];
  /** Music cues whose runtime file does not exist yet. */
  pendingMusic: AuditionItem[];
  state: ReviewState;
  storage: StorageLike | null;
  /** Where `cues.json` is expected, shown when no cue list exists. */
  cuesPath: string;
  musicListed: boolean;
}

/** The whole page: toolbar, two sections of plates, export panel. */
export class AuditionApp {
  private readonly plates = new Map<string, Plate>();
  private readonly counts = new Map<'sfx' | 'music', HTMLElement>();
  private readonly summary = el('p', { class: 'summary' });
  private readonly matchButton = button('Match loudness', 'match', 'tool', {
    'aria-pressed': 'false',
  });
  private readonly exportStatus = el('p', { class: 'export-status', attrs: { role: 'status' } });
  private readonly exportBox = el('textarea', {
    class: 'export-box',
    attrs: { readonly: '', rows: '6', 'aria-label': 'Review lines', hidden: '' },
  });
  private readonly filterButtons = new Map<FilterName, HTMLButtonElement>();
  private filter: FilterName = 'all';
  private frame = 0;
  private meterLevel = 0;

  constructor(private readonly opts: AppOptions) {
    opts.engine.onStop = (key) => this.handleStop(key);
  }

  mount(root: HTMLElement): void {
    root.replaceChildren(
      this.header(),
      this.toolbar(),
      this.sfxSection(),
      this.musicSection(),
      this.exportPanel(),
    );
    this.applyMatchButton();
    this.refreshAll();
    const resize = new ResizeObserver(() => {
      for (const plate of this.plates.values()) this.drawWave(plate);
    });
    resize.observe(root);
  }

  private header(): HTMLElement {
    return el('header', { class: 'masthead' }, [
      el('h1', { text: 'Audio audition' }),
      el('p', {
        class: 'lede',
        text: 'Listen to each sound and music cue, then approve it, reject it, or leave a note. Your marks stay in this browser. Sound effects are review row A17 in the owner review.',
      }),
    ]);
  }

  private toolbar(): HTMLElement {
    this.matchButton.addEventListener('click', () => {
      this.opts.state.match = !this.opts.state.match;
      this.save();
      this.applyMatchButton();
      this.refreshGains();
    });
    const group = el('div', { class: 'segments', attrs: { role: 'group', 'aria-label': 'Show' } });
    for (const [name, label] of FILTERS) {
      const b = button(label, null, 'segment', { 'aria-pressed': String(name === 'all') });
      b.addEventListener('click', () => {
        this.filter = name;
        for (const [n, btn] of this.filterButtons)
          btn.setAttribute('aria-pressed', String(n === name));
        this.applyFilter();
      });
      this.filterButtons.set(name, b);
      group.append(b);
    }
    const exportButton = button('Export review', 'copy', 'tool primary');
    exportButton.addEventListener('click', () => void this.export());
    return el('div', { class: 'toolbar' }, [
      el('div', { class: 'toolbar-row' }, [this.matchButton, group, exportButton]),
      this.summary,
    ]);
  }

  private sfxSection(): HTMLElement {
    const heading = el('h2', { text: 'Sound effects' });
    const count = el('p', { class: 'section-count' });
    this.counts.set('sfx', count);
    const list = el('div', { class: 'plates' });
    for (const item of this.opts.sfx) list.append(this.buildPlate(item, true));
    return el('section', { class: 'section', attrs: { 'aria-label': 'Sound effects' } }, [
      el('div', { class: 'section-head' }, [heading, count]),
      list,
    ]);
  }

  private musicSection(): HTMLElement {
    const count = el('p', { class: 'section-count' });
    this.counts.set('music', count);
    const list = el('div', { class: 'plates' });
    const all = [...this.opts.music, ...this.opts.pendingMusic].sort(
      (a, b) => this.musicOrder(a) - this.musicOrder(b),
    );
    for (const item of all) {
      list.append(this.buildPlate(item, this.opts.music.includes(item)));
    }
    const empty = !this.opts.musicListed
      ? el('p', {
          class: 'empty',
          text: `No music cue list yet. It is read from ${this.opts.cuesPath} when that file exists.`,
        })
      : null;
    return el('section', { class: 'section', attrs: { 'aria-label': 'Music' } }, [
      el('div', { class: 'section-head' }, [el('h2', { text: 'Music' }), count]),
      empty,
      list,
    ]);
  }

  private musicOrder(item: AuditionItem): number {
    const all = [...this.opts.music, ...this.opts.pendingMusic];
    return all.indexOf(item);
  }

  private exportPanel(): HTMLElement {
    return el('section', { class: 'section export', attrs: { 'aria-label': 'Export' } }, [
      this.exportStatus,
      this.exportBox,
    ]);
  }

  private buildPlate(item: AuditionItem, playable: boolean): HTMLElement {
    const badge = el('p', { class: 'badge' });
    const subtitle =
      item.when ??
      item.facts.find((f) => f.label === 'Kind')?.value ??
      (item.kind === 'music' ? 'Music cue' : 'Sound effect');
    const head = el('div', { class: 'plate-head' });
    const play = button('Play', 'play', 'play', { 'aria-label': `Play ${item.title}` });
    if (playable) head.append(play);
    head.append(
      el('div', { class: 'plate-title' }, [
        el('h3', { text: item.title }),
        el('p', { class: 'when', text: subtitle }),
      ]),
      badge,
    );

    const plate: Plate = {
      item,
      root: el('article', {
        class: playable ? 'plate' : 'plate pending',
        attrs: { 'data-key': item.key },
      }),
      play,
      badge,
      canvas: el('canvas', { class: 'wave', attrs: { 'aria-hidden': 'true' } }),
      hint: el('p', { class: 'scope-hint', text: 'Press play to draw the waveform' }),
      playhead: el('div', { class: 'playhead' }),
      meterMask: el('i'),
      time: el('p', { class: 'time', text: seconds(item.durationS) }),
      gainNote: el('p', { class: 'gain-note' }),
      loopToggle: null,
      approve: null,
      reject: null,
      note: null,
      clip: null,
      loop: false,
    };
    plate.root.append(head);

    if (playable) {
      play.addEventListener('click', () => void this.toggle(plate));
      const scope = el('div', { class: 'scope' }, [plate.canvas, plate.hint, plate.playhead]);
      scope.addEventListener('click', () => void this.ensureClip(plate));
      plate.root.append(
        scope,
        el('div', { class: 'meter-row' }, [
          el('div', { class: 'meter', attrs: { 'aria-hidden': 'true' } }, [plate.meterMask]),
          plate.time,
        ]),
        plate.gainNote,
        this.controls(plate),
      );
    } else {
      plate.root.append(
        el('p', {
          class: 'not-yet',
          text: item.url ? 'Not generated yet. The runtime file is missing.' : 'Not generated yet.',
        }),
      );
    }
    plate.root.append(...this.details(item));
    this.plates.set(item.key, plate);
    return plate.root;
  }

  private controls(plate: Plate): HTMLElement {
    const row = el('div', { class: 'controls' });
    if (plate.item.loop) {
      const loop = button('Loop', 'loop', 'tool', { 'aria-pressed': 'false' });
      loop.addEventListener('click', () => {
        plate.loop = !plate.loop;
        loop.setAttribute('aria-pressed', String(plate.loop));
        if (this.opts.engine.playingKey === plate.item.key) this.opts.engine.setLoop(plate.loop);
      });
      plate.loopToggle = loop;
      row.append(loop);
    }
    plate.approve = button('Approve', 'check', 'verdict approve', { 'aria-pressed': 'false' });
    plate.reject = button('Reject', 'cross', 'verdict reject', { 'aria-pressed': 'false' });
    plate.approve.addEventListener('click', () => this.setVerdict(plate, 'approve'));
    plate.reject.addEventListener('click', () => this.setVerdict(plate, 'reject'));
    plate.note = el('input', {
      class: 'note',
      attrs: {
        type: 'text',
        maxlength: '300',
        placeholder: 'Note (optional)',
        'aria-label': `Note for ${plate.item.title}`,
        enterkeyhint: 'done',
      },
    });
    plate.note.value = this.opts.state.items[plate.item.key]?.note ?? '';
    plate.note.addEventListener('input', () => this.setNote(plate, plate.note?.value ?? ''));
    row.append(plate.approve, plate.reject, plate.note);
    return row;
  }

  private details(item: AuditionItem): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (item.prompt) {
      out.push(
        el('div', { class: 'prompt' }, [
          el('p', {
            class: 'field-label',
            text: item.kind === 'sfx' ? 'ElevenLabs prompt' : 'Suno prompt',
          }),
          el('p', { class: 'prompt-text', text: item.prompt }),
        ]),
      );
    }
    if (item.facts.length > 0) {
      const dl = el('dl', { class: 'facts' });
      for (const fact of item.facts) {
        dl.append(el('dt', { text: fact.label }), el('dd', { text: fact.value }));
      }
      out.push(dl);
    }
    if (item.caveat) out.push(el('p', { class: 'caveat', text: item.caveat }));
    return out;
  }

  private async ensureClip(plate: Plate): Promise<Clip | null> {
    if (plate.clip) return plate.clip;
    if (!plate.item.url) return null;
    plate.hint.textContent = 'Loading...';
    try {
      const clip = await this.opts.engine.load(plate.item.url);
      plate.clip = clip;
      plate.hint.hidden = true;
      plate.time.textContent = `0.00 / ${seconds(clip.buffer.duration)}`;
      this.drawWave(plate);
      this.refreshGains();
      return clip;
    } catch (error) {
      plate.hint.textContent = `Could not load: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    }
  }

  private async toggle(plate: Plate): Promise<void> {
    const engine = this.opts.engine;
    if (engine.playingKey === plate.item.key) {
      engine.stop();
      return;
    }
    // Resume inside the click so the browser lets the context run, before any await.
    const unlocked = engine.unlock();
    const clip = await this.ensureClip(plate);
    await unlocked;
    if (!clip) return;
    engine.play(plate.item.key, clip, { loop: plate.loop, gain: this.gainFor(plate).gain });
    plate.play.setAttribute('aria-pressed', 'true');
    plate.play.setAttribute('aria-label', `Stop ${plate.item.title}`);
    plate.play.replaceChildren(icon('stop'), el('span', { class: 'label', text: 'Stop' }));
    plate.root.dataset.playing = 'true';
    this.meterLevel = 0;
    cancelAnimationFrame(this.frame);
    this.tick();
  }

  private handleStop(key: string): void {
    const plate = this.plates.get(key);
    if (!plate) return;
    plate.play.setAttribute('aria-pressed', 'false');
    plate.play.setAttribute('aria-label', `Play ${plate.item.title}`);
    plate.play.replaceChildren(icon('play'), el('span', { class: 'label', text: 'Play' }));
    delete plate.root.dataset.playing;
    plate.playhead.style.left = '0%';
    plate.meterMask.style.width = '100%';
    if (plate.clip) plate.time.textContent = seconds(plate.clip.buffer.duration);
  }

  private tick = (): void => {
    const engine = this.opts.engine;
    const key = engine.playingKey;
    const plate = key ? this.plates.get(key) : undefined;
    const sample = engine.sample();
    if (!plate || !sample) return;
    plate.playhead.style.left = `${(sample.fraction * 100).toFixed(2)}%`;
    const duration = plate.clip?.buffer.duration ?? 0;
    plate.time.textContent = `${(sample.fraction * duration).toFixed(2)} / ${seconds(duration)}`;
    const db = 20 * Math.log10(Math.max(sample.peak, 1e-5));
    const level = Math.min(1, Math.max(0, (db + 60) / 60));
    this.meterLevel = Math.max(level, this.meterLevel - 0.025);
    plate.meterMask.style.width = `${((1 - this.meterLevel) * 100).toFixed(1)}%`;
    this.frame = requestAnimationFrame(this.tick);
  };

  /** Linear gain for a plate under the current "Match loudness" setting. */
  private gainFor(plate: Plate): { gain: number; text: string } {
    if (!this.opts.state.match || !plate.clip) return { gain: 1, text: '' };
    const measured = plate.item.lufs;
    const lufs = measured ?? plate.clip.estimatedLufs();
    if (lufs === null)
      return { gain: 1, text: 'No loudness available, playing at original level.' };
    const m = matchGain(lufs, plate.clip.peak);
    const source = measured === null ? 'estimated' : 'measured';
    const sign = m.gainDb >= 0 ? '+' : '-';
    const limit = m.limited ? ', held by the peak ceiling' : '';
    return {
      gain: m.gain,
      text: `Matched to ${REVIEW_LUFS} LUFS: ${sign}${Math.abs(m.gainDb).toFixed(1)} dB from ${lufs.toFixed(1)} LUFS ${source}${limit}.`,
    };
  }

  private refreshGains(): void {
    for (const plate of this.plates.values()) {
      plate.gainNote.textContent = this.gainFor(plate).text;
    }
    const key = this.opts.engine.playingKey;
    const playing = key ? this.plates.get(key) : undefined;
    if (playing) this.opts.engine.setGain(this.gainFor(playing).gain);
  }

  private applyMatchButton(): void {
    this.matchButton.setAttribute('aria-pressed', String(this.opts.state.match));
  }

  private setVerdict(plate: Plate, verdict: Verdict): void {
    const key = plate.item.key;
    const current = this.opts.state.items[key] ?? { verdict: null, note: '' };
    current.verdict = current.verdict === verdict ? null : verdict;
    this.commit(key, current);
    this.refreshPlate(plate);
    this.refreshSummary();
    this.applyFilter();
  }

  private setNote(plate: Plate, note: string): void {
    const key = plate.item.key;
    const current = this.opts.state.items[key] ?? { verdict: null, note: '' };
    current.note = note;
    this.commit(key, current);
    this.refreshSummary();
  }

  private commit(key: string, review: { verdict: Verdict | null; note: string }): void {
    if (review.verdict || review.note.trim()) this.opts.state.items[key] = review;
    else delete this.opts.state.items[key];
    this.save();
  }

  private save(): void {
    saveState(this.opts.storage, this.opts.state);
  }

  private refreshPlate(plate: Plate): void {
    const verdict = this.opts.state.items[plate.item.key]?.verdict ?? null;
    plate.root.dataset.verdict = verdict ?? 'none';
    plate.badge.textContent = verdict ? VERDICT_TEXT[verdict] : 'Not reviewed';
    plate.approve?.setAttribute('aria-pressed', String(verdict === 'approve'));
    plate.reject?.setAttribute('aria-pressed', String(verdict === 'reject'));
  }

  private refreshAll(): void {
    for (const plate of this.plates.values()) {
      this.refreshPlate(plate);
      plate.meterMask.style.width = '100%';
    }
    this.refreshSummary();
    this.applyFilter();
  }

  private refreshSummary(): void {
    for (const kind of ['sfx', 'music'] as const) {
      const reviewable = [...this.plates.values()].filter(
        (p) => p.item.kind === kind && p.approve !== null,
      );
      const done = reviewable.filter((p) => {
        const r = this.opts.state.items[p.item.key];
        return r?.verdict || r?.note.trim();
      }).length;
      const pending = [...this.plates.values()].filter(
        (p) => p.item.kind === kind && p.approve === null,
      ).length;
      const text = `${done} of ${reviewable.length} reviewed${pending ? `, ${pending} not generated yet` : ''}`;
      const target = this.counts.get(kind);
      if (target) target.textContent = text;
    }
    const states = Object.values(this.opts.state.items);
    const approved = states.filter((r) => r.verdict === 'approve').length;
    const rejected = states.filter((r) => r.verdict === 'reject').length;
    this.summary.textContent = `${approved} approved, ${rejected} rejected, ${states.length - approved - rejected} with a note only`;
  }

  private applyFilter(): void {
    for (const plate of this.plates.values()) {
      const verdict = this.opts.state.items[plate.item.key]?.verdict ?? null;
      const reviewable = plate.approve !== null;
      const show =
        this.filter === 'all' ||
        (reviewable && (this.filter === 'unreviewed' ? verdict === null : verdict === this.filter));
      plate.root.hidden = !show;
    }
  }

  private async export(): Promise<void> {
    const rows = [...this.opts.sfx, ...this.opts.music];
    const text = exportReview(rows, this.opts.state);
    if (!text) {
      this.exportBox.hidden = true;
      this.exportStatus.textContent = 'Nothing to export yet. Approve, reject or add a note first.';
      return;
    }
    const lineCount = text.split('\n').length;
    this.exportBox.value = text;
    this.exportBox.hidden = false;
    this.exportBox.rows = Math.min(14, lineCount + 1);
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      this.exportBox.focus();
      this.exportBox.select();
    }
    this.exportStatus.textContent = copied
      ? `Copied ${lineCount} ${lineCount === 1 ? 'line' : 'lines'}. Paste them into the owner review reply.`
      : `This browser blocked copying. The ${lineCount} ${lineCount === 1 ? 'line is' : 'lines are'} selected below, copy them by hand.`;
  }

  private drawWave(plate: Plate): void {
    const clip = plate.clip;
    const canvas = plate.canvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!clip || width === 0 || height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const g = canvas.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    const style = getComputedStyle(canvas);
    const mid = height / 2;
    const columns = clip.peaks.length / 2;
    const step = width / columns;
    const scale = clip.peak > 0 ? 0.92 / clip.peak : 1;
    g.fillStyle = style.getPropertyValue('--wave-ink') || '#f3be65';
    for (let c = 0; c < columns; c++) {
      const lo = (clip.peaks[c * 2] as number) * scale * mid;
      const hi = (clip.peaks[c * 2 + 1] as number) * scale * mid;
      const barHeight = Math.max(2, hi - lo);
      g.fillRect(c * step, mid - hi, Math.max(1, step - 0.5), barHeight);
    }
  }
}
