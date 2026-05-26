import type { ProfileResponse } from './types';

export async function fetchProfile(): Promise<ProfileResponse | null> {
  const response = await fetch('/api/me');
  if (!response.ok) {
    if (response.status === 401) {
      return null;
    }
    throw new Error(`Request failed with status ${response.status}`);
  }

  return await response.json() as ProfileResponse;
}

export async function postDashboardAction(path: string): Promise<boolean> {
  const response = await fetch(path, { method: 'POST' });
  if (response.status === 401) {
    return false;
  }
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return true;
}

export async function exchangeHandoffToken(authUrl: string, token: string): Promise<void> {
  const response = await fetch(authUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token }),
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const payload = await response.json() as { error?: string };
      if (payload.error) {
        message = payload.error;
      }
    } catch {
      // keep fallback message
    }
    throw new Error(message);
  }
}
