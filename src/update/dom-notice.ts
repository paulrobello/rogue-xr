import { PALETTE } from '../palette.ts';

export interface DomNotice {
  show(): void;
  hide(): void;
  readonly visible: boolean;
  dispose(): void;
}

interface DomNoticeOptions {
  onReload(): void;
  onLater(): void;
  parent?: HTMLElement;
}

const KEY_EVENTS = ['keydown', 'keyup', 'keypress'] as const;

const button = (label: string, primary: boolean): HTMLButtonElement => {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  Object.assign(element.style, {
    font: '600 13px system-ui, sans-serif',
    padding: '6px 14px',
    borderRadius: '6px',
    cursor: 'pointer',
    color: primary ? PALETTE.void : PALETTE.parchment,
    background: primary ? PALETTE.brass : 'transparent',
    border: `1px solid ${primary ? PALETTE.brass : PALETTE.brassDark}`,
  });
  return element;
};

/** The desktop notice: a small bar above the page and every overlay, with Reload and Later. */
export function createDomNotice({
  onReload,
  onLater,
  parent = document.body,
}: DomNoticeOptions): DomNotice {
  const root = document.createElement('div');
  root.id = 'update-notice';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  Object.assign(root.style, {
    position: 'fixed',
    left: '50%',
    bottom: '20px',
    transform: 'translateX(-50%)',
    zIndex: '2147483000',
    display: 'none',
    alignItems: 'center',
    gap: '14px',
    padding: '10px 14px',
    font: '500 14px system-ui, sans-serif',
    color: PALETTE.parchment,
    background: 'rgba(18,12,7,0.94)',
    border: `1px solid ${PALETTE.brass}`,
    borderRadius: '10px',
    boxShadow: '0 4px 18px rgba(0,0,0,0.5)',
  });
  const text = document.createElement('span');
  text.textContent = 'A new version of Clockwork Spire is available.';
  const reload = button('Reload', true);
  const later = button('Later', false);
  reload.addEventListener('click', onReload);
  later.addEventListener('click', onLater);
  root.append(text, reload, later);
  // Typing in the notice must not drive the game's input map.
  const swallow = (event: Event): void => event.stopPropagation();
  for (const type of KEY_EVENTS) root.addEventListener(type, swallow);
  parent.append(root);

  return {
    show() {
      // An inline `display` outranks the `hidden` attribute, so visibility is the style itself.
      root.style.display = 'flex';
    },
    hide() {
      root.style.display = 'none';
    },
    get visible() {
      return root.style.display !== 'none';
    },
    dispose() {
      root.remove();
    },
  };
}
