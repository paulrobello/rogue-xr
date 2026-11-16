import type { FrameWindow } from './frame-stats.ts';
import { XR_SCALE_OPTIONS, type XrScale } from './xr-perf.ts';

export interface DebugPanelOptions {
  parent: HTMLElement;
  scale: XrScale;
  /** Called with the chosen scale; returns a status line for the panel. */
  onScale(scale: XrScale): string;
  /** Called when the user asks for the frame log; returns the JSON text to save. */
  onDownload(): string;
}

export interface DebugPanel {
  readonly element: HTMLElement;
  setWindow(window: FrameWindow | null): void;
  dispose(): void;
}

export function formatWindow(window: FrameWindow | null): string {
  if (!window) return 'no 2 s window yet';
  return `${window.fps.toFixed(1)} fps | p50 ${window.p50.toFixed(1)} | p95 ${window.p95.toFixed(1)} | worst ${window.worst.toFixed(1)} ms`;
}

/** Desktop-only panel: pick the XR framebuffer scale before Enter VR and save the frame log. */
export function createDebugPanel(options: DebugPanelOptions): DebugPanel {
  const element = document.createElement('div');
  element.id = 'perf-panel';
  Object.assign(element.style, {
    position: 'fixed',
    top: '12px',
    right: '12px',
    display: 'grid',
    gap: '6px',
    padding: '10px 12px',
    font: '500 12px ui-monospace, monospace',
    color: '#e8dcc0',
    background: 'rgba(16, 14, 12, 0.82)',
    border: '1px solid #8a6d3b',
    borderRadius: '6px',
  });

  const title = document.createElement('strong');
  title.textContent = 'Perf';

  const label = document.createElement('label');
  label.textContent = 'XR framebuffer scale ';
  const select = document.createElement('select');
  for (const scale of XR_SCALE_OPTIONS) {
    const option = document.createElement('option');
    option.value = String(scale);
    option.textContent = scale.toFixed(2);
    select.append(option);
  }
  select.value = String(options.scale);
  label.append(select);

  const status = document.createElement('div');
  status.textContent = 'Scale applies at the next Enter VR.';
  const readout = document.createElement('div');
  readout.textContent = formatWindow(null);

  const download = document.createElement('button');
  download.type = 'button';
  download.textContent = 'Download frame log (JSON)';

  const onChange = (): void => {
    status.textContent = options.onScale(Number(select.value) as XrScale);
  };
  const onClick = (): void => {
    const url = URL.createObjectURL(new Blob([options.onDownload()], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `rogue-xr-frames-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  select.addEventListener('change', onChange);
  download.addEventListener('click', onClick);

  element.append(title, label, status, readout, download);
  options.parent.append(element);

  return {
    element,
    setWindow(window) {
      readout.textContent = formatWindow(window);
    },
    dispose() {
      select.removeEventListener('change', onChange);
      download.removeEventListener('click', onClick);
      element.remove();
    },
  };
}
