function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing loading screen element: ${id}`);
  return node;
}

const cover = element('loading-screen');
const app = element('app');
const status = element('loading-status');
const retry = element('loading-retry');
retry.addEventListener('click', () => location.reload());

export function showLoading(message: string): void {
  app.inert = true;
  cover.hidden = false;
  delete cover.dataset.failed;
  retry.hidden = true;
  status.textContent = message;
}

export function failLoading(error: unknown): void {
  console.error('Clockwork Spire could not load', error);
  showLoading('The tower could not be loaded.');
  cover.dataset.failed = '';
  retry.hidden = false;
}

export function revealGame(): void {
  cover.hidden = true;
  app.inert = false;
}
