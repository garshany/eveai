import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function requiredInt(name: string): number {
  const raw = required(name);
  const num = Number(raw);
  if (!Number.isFinite(num)) throw new Error(`Env var ${name} must be a number, got: "${raw}"`);
  return num;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return (value !== undefined && value !== '') ? value : fallback;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const num = Number(raw);
  if (!Number.isFinite(num)) throw new Error(`Env var ${name} must be a number, got: "${raw}"`);
  return num;
}

export const config = {
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    allowedUserId: requiredInt('ALLOWED_TELEGRAM_USER_ID'),
  },
  openai: {
    apiKey: required('OPENAI_API_KEY'),
    model: optional('OPENAI_MODEL', 'gpt-5.4'),
  },
  eve: {
    clientId: required('EVE_CLIENT_ID'),
    clientSecret: required('EVE_CLIENT_SECRET'),
    callbackUrl: optional('EVE_CALLBACK_URL', 'http://localhost:3000/auth/eve/callback'),
  },
  server: {
    port: optionalInt('PORT', 3000),
    host: optional('HOST', '0.0.0.0'),
  },
  db: {
    path: optional('DB_PATH', './data/eve-agent.db'),
  },
  sde: {
    dataDir: optional('SDE_DATA_DIR', './data/sde'),
  },
} as const;
