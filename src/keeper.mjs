// One keeper tick: inside the active window wake the backend (GET HEALTH_PATH, default /health?db=1, retried through a
// Render cold start) and, on sync ticks, run the Google sync (POST /google/sync + X-Sync-Secret).
// Runtime-neutral: only fetch, AbortSignal.timeout and Intl — works in Cloudflare Workers and Node 18+.
import { isActive, isSyncTick, localTime } from "./schedule.mjs";

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text.slice(0, 200);
  }
}

function describe(err) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timeout";
  return err?.cause?.code || err?.message || String(err);
}

// Render answers a sleeping service only once it has booted (~23 s), sometimes with a 502/503 from
// its proxy first; Neon may also be waking (503 from ?db=1). Retry those until the budget runs out.
export async function wake(config, { fetch, sleep = defaultSleep, clock = Date.now }) {
  const started = clock();
  const errors = [];
  for (let attempt = 1; ; attempt++) {
    const attemptStarted = clock();
    let retryable = true;
    try {
      const res = await fetch(`${config.backendUrl}${config.healthPath}`, {
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(config.wakeAttemptTimeoutMs),
      });
      const body = await readJson(res);
      // any 2xx counts, unless the body explicitly says {"ok": false} (e.g. a non-JSON or {"status":"up"} health)
      if (res.ok && body?.ok !== false) {
        return { ok: true, status: res.status, db: body.db === true, attempts: attempt, ms: clock() - started, firstAttemptMs: attempt === 1 ? clock() - attemptStarted : undefined };
      }
      errors.push(`HTTP ${res.status}`);
      retryable = res.status >= 500 || res.status === 429;
    } catch (err) {
      errors.push(describe(err));
    }
    const elapsed = clock() - started;
    if (!retryable || elapsed + config.wakeRetryDelayMs >= config.wakeBudgetMs) {
      return { ok: false, attempts: attempt, ms: elapsed, error: errors.join("; ") };
    }
    await sleep(config.wakeRetryDelayMs);
  }
}

const COUNTERS = ["created", "updated", "flagged", "unchanged", "skipped", "excluded"];

// condense the backend's per-account results into numbers + error texts
export function summarizeSync(results) {
  const summary = { accounts: results.length, import: Object.fromEntries(COUNTERS.map((k) => [k, 0])), export: { created: 0, updated: 0, deleted: 0 }, errors: [] };
  for (const r of results) {
    if (r.error) summary.errors.push(`user ${r.userId}: ${r.error}`);
    for (const k of COUNTERS) summary.import[k] += r.import?.[k] ?? 0;
    for (const e of r.import?.errors ?? []) summary.errors.push(`user ${r.userId}${e.calendarId ? ` (${e.calendarId})` : ""}: ${e.error}`);
    for (const k of ["created", "updated", "deleted"]) summary.export[k] += r.export?.[k] ?? 0;
    for (const e of r.export?.errors ?? []) summary.errors.push(`user ${r.userId} export #${e.appointmentId}: ${e.error}`);
  }
  return summary;
}

export async function sync(config, { fetch, clock = Date.now }) {
  if (!config.syncSecret) return { ok: true, skipped: "SYNC_SECRET is not set — only waking the backend" };
  const started = clock();
  try {
    const res = await fetch(`${config.backendUrl}/google/sync`, {
      method: "POST",
      headers: { "X-Sync-Secret": config.syncSecret },
      signal: AbortSignal.timeout(config.syncTimeoutMs),
    });
    const body = await readJson(res);
    const ms = clock() - started;
    if (res.status === 401) return { ok: false, status: 401, ms, error: "secret rejected: SYNC_SECRET must equal GOOGLE_SYNC_SECRET on the backend (and it must be set there)" };
    if (!res.ok || !Array.isArray(body?.results)) return { ok: false, status: res.status, ms, error: typeof body === "string" ? body : body?.error || `HTTP ${res.status}` };
    const summary = summarizeSync(body.results);
    return {
      ok: summary.errors.length === 0,
      status: res.status,
      ms,
      ...summary,
      ...(summary.accounts === 0 ? { note: "no Google account is connected in the CRM — nothing to sync" } : {}),
    };
  } catch (err) {
    return { ok: false, ms: clock() - started, error: describe(err) };
  }
}

// force: ignore the window (manual run). Returns a report; report.ok is false when something needs attention.
export async function runTick(config, { now = new Date(), fetch, sleep, clock, force = false, forceSync = force } = {}) {
  const local = localTime(now, config.timeZone);
  const report = { at: now.toISOString(), local: local.label, timeZone: config.timeZone, active: isActive(now, config), forced: force || undefined };
  if (!report.active && !force) {
    report.ok = true;
    report.action = "idle (outside the active window)";
    return report;
  }
  report.wake = await wake(config, { fetch, sleep, clock });
  const wantSync = forceSync || isSyncTick(now, config);
  if (!wantSync) {
    report.sync = { skipped: "not a sync tick" };
  } else if (!report.wake.ok) {
    report.sync = { skipped: "backend did not wake up" };
  } else {
    report.sync = await sync(config, { fetch, clock });
  }
  report.ok = report.wake.ok && report.sync.ok !== false;
  return report;
}
