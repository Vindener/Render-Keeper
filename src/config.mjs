// Keeper settings, read from a plain object of strings: Cloudflare Worker `env` or Node `process.env`.
//
//   BACKEND_URL     (required) API base, e.g. https://<your-app>.onrender.com/api
//   HEALTH_PATH     wake-up path appended to BACKEND_URL; default /health?db=1
//   SYNC_SECRET     the backend's GOOGLE_SYNC_SECRET; without it only the wake-up ping runs
//   TIMEZONE        default Europe/Kyiv
//   ACTIVE_HOURS    local window, end exclusive; default 08:00-22:00
//   ACTIVE_DAYS     ISO weekdays (1 = Mon … 7 = Sun), "1-7" or "1,2,3,4,7"; default 1-7
//   TICK_MIN        how often the scheduler fires (the cron step); default 10
//   SYNC_EVERY_MIN  Google sync cadence inside the window, a multiple of TICK_MIN; 0 = never; default 30
//   WAKE_BUDGET_MS  how long to keep retrying a sleeping backend; default 120000
//   WAKE_ATTEMPT_TIMEOUT_MS  one health request; default 45000 (Render cold start ≈ 23 s)
//   SYNC_TIMEOUT_MS one sync request; default 90000

export class ConfigError extends Error {}

const DEFAULTS = {
  HEALTH_PATH: "/health?db=1",
  TIMEZONE: "Europe/Kyiv",
  ACTIVE_HOURS: "08:00-22:00",
  ACTIVE_DAYS: "1-7",
  TICK_MIN: "10",
  SYNC_EVERY_MIN: "30",
  WAKE_BUDGET_MS: "120000",
  WAKE_ATTEMPT_TIMEOUT_MS: "45000",
  WAKE_RETRY_DELAY_MS: "5000",
  SYNC_TIMEOUT_MS: "90000",
};

function parseClock(text, name) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59 || (Number(m[1]) === 24 && Number(m[2]) !== 0)) {
    throw new ConfigError(`${name}: "${text}" is not a time like 08:00`);
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

export function parseHours(text) {
  const parts = String(text).split("-");
  if (parts.length !== 2) throw new ConfigError(`ACTIVE_HOURS: "${text}" must look like 08:00-22:00`);
  const start = parseClock(parts[0], "ACTIVE_HOURS");
  const end = parseClock(parts[1], "ACTIVE_HOURS");
  if (start === end) throw new ConfigError("ACTIVE_HOURS: start and end must differ");
  return { start, end };
}

export function parseDays(text) {
  const days = new Set();
  for (const raw of String(text).split(",")) {
    const part = raw.trim();
    const range = /^([1-7])-([1-7])$/.exec(part);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (a > b) throw new ConfigError(`ACTIVE_DAYS: range "${part}" goes backwards`);
      for (let d = a; d <= b; d++) days.add(d);
    } else if (/^[1-7]$/.test(part)) {
      days.add(Number(part));
    } else {
      throw new ConfigError(`ACTIVE_DAYS: "${part}" is not an ISO weekday 1-7 or a range`);
    }
  }
  return days;
}

function positiveInt(value, name, { allowZero = false } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || (!allowZero && n === 0)) throw new ConfigError(`${name}: "${value}" must be a ${allowZero ? "non-negative" : "positive"} integer`);
  return n;
}

export function loadConfig(env = {}) {
  const get = (key) => {
    const v = env[key];
    return v === undefined || v === null || String(v).trim() === "" ? DEFAULTS[key] : String(v).trim();
  };
  const backendUrl = get("BACKEND_URL");
  if (!backendUrl) throw new ConfigError("BACKEND_URL is required (e.g. https://<app>.onrender.com/api)");
  let parsedUrl;
  try {
    parsedUrl = new URL(backendUrl);
  } catch {
    throw new ConfigError(`BACKEND_URL: "${backendUrl}" is not a URL`);
  }
  if (!/^https?:$/.test(parsedUrl.protocol)) throw new ConfigError("BACKEND_URL must be http(s)");

  const healthPath = get("HEALTH_PATH");
  if (!healthPath.startsWith("/")) throw new ConfigError(`HEALTH_PATH: "${healthPath}" must start with /`);

  const timeZone = get("TIMEZONE");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new ConfigError(`TIMEZONE: "${timeZone}" is not a known IANA time zone`);
  }

  const tickMin = positiveInt(get("TICK_MIN"), "TICK_MIN");
  const syncEveryMin = positiveInt(get("SYNC_EVERY_MIN"), "SYNC_EVERY_MIN", { allowZero: true });
  if (syncEveryMin % tickMin !== 0) throw new ConfigError(`SYNC_EVERY_MIN (${syncEveryMin}) must be a multiple of TICK_MIN (${tickMin})`);

  return {
    backendUrl: backendUrl.replace(/\/+$/, ""),
    healthPath,
    syncSecret: env.SYNC_SECRET ? String(env.SYNC_SECRET) : null,
    timeZone,
    hours: parseHours(get("ACTIVE_HOURS")),
    hoursText: get("ACTIVE_HOURS"),
    days: parseDays(get("ACTIVE_DAYS")),
    daysText: get("ACTIVE_DAYS"),
    tickMin,
    syncEveryMin,
    wakeBudgetMs: positiveInt(get("WAKE_BUDGET_MS"), "WAKE_BUDGET_MS"),
    wakeAttemptTimeoutMs: positiveInt(get("WAKE_ATTEMPT_TIMEOUT_MS"), "WAKE_ATTEMPT_TIMEOUT_MS"),
    wakeRetryDelayMs: positiveInt(get("WAKE_RETRY_DELAY_MS"), "WAKE_RETRY_DELAY_MS", { allowZero: true }),
    syncTimeoutMs: positiveInt(get("SYNC_TIMEOUT_MS"), "SYNC_TIMEOUT_MS"),
  };
}

// what is safe to show (no secret)
export function publicConfig(config) {
  return {
    backendUrl: config.backendUrl,
    healthPath: config.healthPath,
    timeZone: config.timeZone,
    activeHours: config.hoursText,
    activeDays: config.daysText,
    tickMin: config.tickMin,
    syncEveryMin: config.syncEveryMin,
    syncSecretSet: Boolean(config.syncSecret),
  };
}
