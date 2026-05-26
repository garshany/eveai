import type { AppConfig, PageKind } from './types';

export function readConfig(root: HTMLElement): AppConfig {
  const page: PageKind = root.dataset.page === 'dashboard'
    ? 'dashboard'
    : root.dataset.page === 'handoff'
      ? 'handoff'
      : 'landing';

  return {
    page,
    botUsername: root.dataset.botUsername ?? '',
    authUrl: root.dataset.authUrl ?? '',
    botLink: root.dataset.botLink ?? '',
  };
}
