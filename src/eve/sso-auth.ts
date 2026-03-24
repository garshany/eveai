import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config.js';
import { fetchWithTimeout } from './http.js';

export interface EveJwtPayload {
  sub: string;
  name: string;
  scp?: string | string[];
  iss?: string;
  exp?: number;
  aud?: string | string[];
}

type SsoMetadata = {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

const WELL_KNOWN_URL = 'https://login.eveonline.com/.well-known/oauth-authorization-server';
const DEFAULT_METADATA: SsoMetadata = {
  authorization_endpoint: 'https://login.eveonline.com/v2/oauth/authorize',
  token_endpoint: 'https://login.eveonline.com/v2/oauth/token',
  jwks_uri: 'https://login.eveonline.com/oauth/jwks',
};
const ACCEPTED_ISSUERS = [
  'login.eveonline.com',
  'https://login.eveonline.com',
  'https://login.eveonline.com/',
];
const METADATA_TTL_MS = 60 * 60 * 1000;

let metadataCache: { value: SsoMetadata; expiresAt: number } | null = null;
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function getEveSsoMetadata(): Promise<SsoMetadata> {
  if (metadataCache && metadataCache.expiresAt > Date.now()) {
    return metadataCache.value;
  }

  try {
    const res = await fetchWithTimeout(WELL_KNOWN_URL, {
      headers: {
        Accept: 'application/json',
        'User-Agent': config.esi.userAgent,
      },
    }, config.eve.requestTimeoutMs);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json() as Partial<SsoMetadata>;
    if (!isValidMetadata(data)) {
      throw new Error('invalid metadata payload');
    }
    metadataCache = {
      value: data,
      expiresAt: Date.now() + METADATA_TTL_MS,
    };
    return data;
  } catch (error) {
    console.warn(`[sso] Falling back to default SSO metadata: ${(error as Error).message}`);
    metadataCache = {
      value: DEFAULT_METADATA,
      expiresAt: Date.now() + 60_000,
    };
    return DEFAULT_METADATA;
  }
}

export async function verifyEveAccessToken(token: string): Promise<EveJwtPayload> {
  const metadata = await getEveSsoMetadata();
  let jwks = jwksCache.get(metadata.jwks_uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
    jwksCache.set(metadata.jwks_uri, jwks);
  }

  const { payload } = await jwtVerify(token, jwks, {
    issuer: ACCEPTED_ISSUERS,
  });

  const data = payload as unknown as EveJwtPayload;
  const aud = Array.isArray(data.aud) ? data.aud : data.aud ? [data.aud] : [];

  if (!aud.includes(config.eve.clientId) || !aud.includes('EVE Online')) {
    throw new Error(`Invalid JWT audience: ${aud.join(', ') || 'missing'}`);
  }

  if (!data.sub || !data.sub.startsWith('CHARACTER:EVE:')) {
    throw new Error(`Invalid JWT subject: ${data.sub}`);
  }

  if (!data.name) {
    throw new Error('JWT missing character name');
  }

  return data;
}

export function resetEveSsoMetadataCacheForTests(): void {
  metadataCache = null;
  jwksCache.clear();
}

function isValidMetadata(value: Partial<SsoMetadata>): value is SsoMetadata {
  return typeof value.authorization_endpoint === 'string'
    && typeof value.token_endpoint === 'string'
    && typeof value.jwks_uri === 'string';
}
