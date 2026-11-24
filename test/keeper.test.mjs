import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";
import { runTick, summarizeSync, wake } from "../src/keeper.mjs";
import worker from "../src/worker.mjs";

const API = "https://api.example.test/api";
const cfg = (extra = {}) => loadConfig({ BACKEND_URL: API, WAKE_RETRY_DELAY_MS: "1000", WAKE_BUDGET_MS: "10000", ...extra });
// Tue 08:00 Kyiv (sync tick) / 08:10 (ping only) / 23:00 (outside)
const SYNC_TICK = new Date("2026-11-17T06:00:00Z");
const PING_TICK = new Date("2026-11-17T06:10:00Z");
const NIGHT = new Date("2026-11-17T21:00:00Z");

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// scripted fetch: each route is a list of responses (Response | Error), consumed in order
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const key = `${init.method || "GET"} ${new URL(url).pathname}${new URL(url).search}`;
    calls.push({ key, headers: init.headers ?? {} });
    const queue = routes[key];
    if (!queue || queue.length === 0) throw new Error(`unexpected request ${key}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next.clone();
  };
  fn.calls = calls;
  return fn;
}

// virtual clock: sleep advances time instantly
function virtualClock() {
  let t = 0;
  return { clock: () => t, sleep: async (ms) => void (t += ms), advance: (ms) => (t += ms) };
}

const HEALTH = "GET /api/health?db=1";
const SYNC = "POST /api/google/sync";

test("outside the window: no request at all", async () => {
  const fetch = fakeFetch({});
  const report = await runTick(cfg({ SYNC_SECRET: "s" }), { now: NIGHT, fetch });
  assert.equal(report.ok, true);
  assert.equal(report.active, false);
  assert.equal(fetch.calls.length, 0);
});

test("ping tick: wakes, does not sync", async () => {
  const fetch = fakeFetch({ [HEALTH]: [jsonResponse(200, { ok: true, db: true })] });
  const report = await runTick(cfg({ SYNC_SECRET: "s" }), { now: PING_TICK, fetch });
  assert.equal(report.ok, true);
  assert.equal(report.wake.ok, true);
  assert.equal(report.wake.db, true);
  assert.equal(report.sync.skipped, "not a sync tick");
  assert.deepEqual(fetch.calls.map((c) => c.key), [HEALTH]);
});

test("cold start: retries 502/503/network errors until healthy", async () => {
  const v = virtualClock();
  const fetch = fakeFetch({
    [HEALTH]: [
      () => (v.advance(2000), jsonResponse(502, { error: "bad gateway" })),
      () => { v.advance(1000); throw new TypeError("fetch failed"); },
      () => (v.advance(500), jsonResponse(503, { ok: false })),
      () => (v.advance(300), jsonResponse(200, { ok: true, db: true })),
    ],
  });
  const result = await wake(cfg(), { fetch, ...v });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 4);
  assert.equal(result.ms, 2000 + 1000 + 500 + 300 + 3 * 1000);
});

test("wake gives up after the budget and reports why", async () => {
  const v = virtualClock();
  const fetch = fakeFetch({ [HEALTH]: [() => (v.advance(3000), jsonResponse(503, { ok: false }))] });
  const result = await wake(cfg(), { fetch, ...v });
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 503/);
  assert.ok(result.ms < 10000 + 3000, `stopped near the budget, got ${result.ms}`);
  assert.ok(result.attempts >= 2);
});

test("a 404 from health is not retried (wrong BACKEND_URL)", async () => {
  const fetch = fakeFetch({ [HEALTH]: [jsonResponse(404, { error: "Not found" })] });
  const result = await wake(cfg(), { fetch, ...virtualClock() });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
});

test("sync tick: wakes, then syncs with the secret header and summarises", async () => {
  const results = [
    {
      userId: 1,
      at: "x",
      import: { created: 2, updated: 1, flagged: 0, unchanged: 5, skipped: 1, excluded: 0, errors: [{ calendarId: "work", error: "gone" }] },
      export: { created: 1, updated: 0, deleted: 0, errors: [] },
    },
  ];
  const fetch = fakeFetch({ [HEALTH]: [jsonResponse(200, { ok: true, db: true })], [SYNC]: [jsonResponse(200, { ok: true, results })] });
  const report = await runTick(cfg({ SYNC_SECRET: "top-secret" }), { now: SYNC_TICK, fetch });
  assert.deepEqual(fetch.calls.map((c) => c.key), [HEALTH, SYNC]);
  assert.equal(fetch.calls[1].headers["X-Sync-Secret"], "top-secret");
  assert.equal(report.sync.import.created, 2);
  assert.equal(report.sync.export.created, 1);
  assert.deepEqual(report.sync.errors, ["user 1 (work): gone"]);
  assert.equal(report.ok, false, "a calendar error must be surfaced");
});

test("sync tick without a secret: ping only, still ok", async () => {
  const fetch = fakeFetch({ [HEALTH]: [jsonResponse(200, { ok: true, db: true })] });
  const report = await runTick(cfg(), { now: SYNC_TICK, fetch });
  assert.equal(report.ok, true);
  assert.match(report.sync.skipped, /SYNC_SECRET/);
  assert.equal(fetch.calls.length, 1);
});

test("rejected secret and backend errors are reported", async () => {
  let fetch = fakeFetch({ [HEALTH]: [jsonResponse(200, { ok: true })], [SYNC]: [jsonResponse(401, { error: "Invalid sync secret" })] });
  let report = await runTick(cfg({ SYNC_SECRET: "wrong" }), { now: SYNC_TICK, fetch });
  assert.equal(report.ok, false);
  assert.match(report.sync.error, /GOOGLE_SYNC_SECRET/);

  fetch = fakeFetch({ [HEALTH]: [jsonResponse(200, { ok: true })], [SYNC]: [jsonResponse(500, { error: "Internal server error" })] });
  report = await runTick(cfg({ SYNC_SECRET: "s" }), { now: SYNC_TICK, fetch });
  assert.equal(report.ok, false);
  assert.equal(report.sync.error, "Internal server error");

  fetch = fakeFetch({ [HEALTH]: [jsonResponse(200, { ok: true })], [SYNC]: [jsonResponse(200, { ok: true, results: [{ userId: 1, error: "Доступ до Google відкликано" }] })] });
  report = await runTick(cfg({ SYNC_SECRET: "s" }), { now: SYNC_TICK, fetch });
  assert.equal(report.ok, false);
  assert.deepEqual(report.sync.errors, ["user 1: Доступ до Google відкликано"]);
});

test("no Google account connected: ok with a note", async () => {
  const fetch = fakeFetch({ [HEALTH]: [jsonResponse(200, { ok: true })], [SYNC]: [jsonResponse(200, { ok: true, results: [] })] });
  const report = await runTick(cfg({ SYNC_SECRET: "s" }), { now: SYNC_TICK, fetch });
  assert.equal(report.ok, true);
  assert.equal(report.sync.accounts, 0);
  assert.match(report.sync.note, /no Google account/);
});

test("sync is skipped when the backend did not wake", async () => {
  const fetch = fakeFetch({ [HEALTH]: [jsonResponse(404, {})] });
  const report = await runTick(cfg({ SYNC_SECRET: "s" }), { now: SYNC_TICK, fetch });
  assert.equal(report.ok, false);
  assert.equal(report.sync.skipped, "backend did not wake up");
  assert.equal(fetch.calls.length, 1);
});

test("force runs wake + sync outside the window", async () => {
  const fetch = fakeFetch({ [HEALTH]: [jsonResponse(200, { ok: true })], [SYNC]: [jsonResponse(200, { ok: true, results: [] })] });
  const report = await runTick(cfg({ SYNC_SECRET: "s" }), { now: NIGHT, fetch, force: true });
  assert.equal(report.ok, true);
  assert.deepEqual(fetch.calls.map((c) => c.key), [HEALTH, SYNC]);
});

test("summarizeSync adds accounts up", () => {
  const s = summarizeSync([
    { userId: 1, import: { created: 1, updated: 0, flagged: 1, errors: [] } },
    { userId: 2, import: { created: 2, updated: 3, flagged: 0, errors: [] }, export: { created: 0, updated: 4, deleted: 1, errors: [{ appointmentId: 9, error: "x" }] } },
  ]);
  assert.equal(s.accounts, 2);
  assert.deepEqual([s.import.created, s.import.updated, s.import.flagged], [3, 3, 1]);
  assert.deepEqual(s.export, { created: 0, updated: 4, deleted: 1 });
  assert.deepEqual(s.errors, ["user 2 export #9: x"]);
});

// --- Worker entry (global fetch swapped for the scripted one) ---

async function withGlobalFetch(fake, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const ENV = { BACKEND_URL: API, SYNC_SECRET: "worker-secret" };

test("worker.scheduled uses the cron's scheduledTime and throws when the tick fails", async () => {
  const idle = fakeFetch({});
  await withGlobalFetch(idle, () => worker.scheduled({ scheduledTime: NIGHT.getTime(), cron: "*/10 * * * *" }, ENV));
  assert.equal(idle.calls.length, 0);

  const good = fakeFetch({ [HEALTH]: [jsonResponse(200, { ok: true })], [SYNC]: [jsonResponse(200, { ok: true, results: [] })] });
  await withGlobalFetch(good, () => worker.scheduled({ scheduledTime: SYNC_TICK.getTime() }, ENV));
  assert.deepEqual(good.calls.map((c) => c.key), [HEALTH, SYNC]);

  const bad = fakeFetch({ [HEALTH]: [jsonResponse(404, {})] });
  await assert.rejects(withGlobalFetch(bad, () => worker.scheduled({ scheduledTime: PING_TICK.getTime() }, ENV)), /needs attention/);
});

test("worker.fetch: status page hides the secret, /run needs it", async () => {
  const status = await worker.fetch(new Request("https://keeper.test/"), ENV);
  assert.equal(status.status, 200);
  const body = await status.text();
  assert.ok(!body.includes("worker-secret"));
  assert.equal(JSON.parse(body).config.syncSecretSet, true);

  assert.equal((await worker.fetch(new Request("https://keeper.test/run", { method: "POST" }), ENV)).status, 401);
  assert.equal((await worker.fetch(new Request("https://keeper.test/run", { method: "POST", headers: { "X-Sync-Secret": "worker-secreT" } }), ENV)).status, 401);
  assert.equal((await worker.fetch(new Request("https://keeper.test/nope"), ENV)).status, 404);

  const fake = fakeFetch({ [HEALTH]: [jsonResponse(200, { ok: true })], [SYNC]: [jsonResponse(200, { ok: true, results: [] })] });
  const run = await withGlobalFetch(fake, () => worker.fetch(new Request("https://keeper.test/run", { method: "POST", headers: { "X-Sync-Secret": "worker-secret" } }), ENV));
  assert.equal(run.status, 200);
  assert.equal((await run.json()).forced, true);

  const broken = await worker.fetch(new Request("https://keeper.test/"), {});
  assert.equal(broken.status, 500, "missing BACKEND_URL is reported, not thrown");
});

test("HEALTH_PATH: another backend with a plain /health is woken without sync", async () => {
  const fetch = fakeFetch({ "GET /health": [new Response("OK", { status: 200 })] });
  const config = loadConfig({ BACKEND_URL: "https://other.example.test/", HEALTH_PATH: "/health", SYNC_EVERY_MIN: "0" });
  const report = await runTick(config, { now: SYNC_TICK, fetch });
  assert.equal(report.ok, true);
  assert.equal(report.wake.ok, true);
  assert.equal(report.sync.skipped, "not a sync tick");
  assert.deepEqual(fetch.calls.map((c) => c.key), ["GET /health"]);
});

test("a 2xx health that says ok:false is a failure, not trusted", async () => {
  const fetch = fakeFetch({ [HEALTH]: [jsonResponse(200, { ok: false })] });
  const result = await wake(cfg(), { fetch, ...virtualClock() });
  assert.equal(result.ok, false);
  assert.equal(result.error, "HTTP 200");
});

test("HEALTH_PATH must start with /", () => {
  assert.throws(() => loadConfig({ BACKEND_URL: API, HEALTH_PATH: "health" }), /HEALTH_PATH/);
});
