import type { ActionBus } from '../core/actions.ts';
import { formatSeed, isValidSeed, normalizeSeed } from '../core/rng.ts';
import { PALETTE } from '../palette.ts';

/** Debug title strip: shows the run seed and starts a new run from a typed or random seed. */
export function mountSeedTitle(parent: HTMLElement, seed: string, actions: ActionBus): HTMLElement {
  const root = document.createElement('form');
  root.id = 'seed-title';
  Object.assign(root.style, {
    position: 'fixed',
    top: '12px',
    right: '12px',
    display: 'flex',
    gap: '6px',
    alignItems: 'center',
    font: '500 13px ui-monospace, monospace',
    color: PALETTE.candle,
  });
  const label = document.createElement('span');
  label.textContent = `run ${formatSeed(seed)}`;
  const input = document.createElement('input');
  input.name = 'seed';
  input.placeholder = 'XXXX-XXXX';
  input.maxLength = 9;
  input.size = 10;
  input.autocomplete = 'off';
  input.spellcheck = false;
  const go = document.createElement('button');
  go.type = 'submit';
  go.textContent = 'Go';
  const random = document.createElement('button');
  random.type = 'button';
  random.textContent = 'New random seed';
  for (const el of [input, go, random]) {
    Object.assign(el.style, {
      font: 'inherit',
      color: PALETTE.void,
      background: PALETTE.brass,
      border: 'none',
      borderRadius: '4px',
      padding: '4px 8px',
    });
  }
  root.append(label, input, go, random);

  root.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!isValidSeed(input.value)) {
      input.setCustomValidity('8 characters: 0-9 and A-Z without I, L, O, U');
      input.reportValidity();
      return;
    }
    actions.emit({ type: 'new-run', seed: normalizeSeed(input.value) });
  });
  input.addEventListener('input', () => input.setCustomValidity(''));
  random.addEventListener('click', () => actions.emit({ type: 'new-run' }));
  parent.append(root);
  return root;
}
