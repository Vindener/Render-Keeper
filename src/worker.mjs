// Cloudflare Worker entry. Cron Triggers are UTC-only, so the cron fires every TICK_MIN minutes
// around the clock and runTick decides by the local window (cheap no-op outside it).
//   GET  /      — status: is the window open now, settings (never the secret)
//   POST /run   — manual tick ignoring the window (wake + sync), header X-Sync-Secret: <SYNC_SECRET>
import { loadConfig, publicConfig } from "./config.mjs";
import { runTick } from "./keeper.mjs";
import { isActive, isSyncTick, localTime } from "./schedule.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

// constant-time for equal lengths; node:crypto is not available without compatibility flags
function secretMatches(given, expected) {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export default {
  async scheduled(event, env) {
    const config = loadConfig(env);
    const report = await runTick(config, { now: new Date(event.scheduledTime), fetch: (...args) => fetch(...args) });
    console.log(JSON.stringify(report));
    // a thrown error marks the invocation as failed in the dashboard (Workers → Logs / cron events)
    if (!report.ok) throw new Error(`keeper tick needs attention: ${report.wake?.error || report.sync?.error || "see log"}`);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    let config;
    try {
      config = loadConfig(env);
    } catch (err) {
      return json({ ok: false, error: err.message }, 500);
    }
    if (url.pathname === "/" && request.method === "GET") {
      const now = new Date();
      return json({ service: "render-keeper", now: now.toISOString(), local: localTime(now, config.timeZone).label, active: isActive(now, config), syncTick: isSyncTick(now, config), config: publicConfig(config) });
    }
    if (url.pathname === "/run" && request.method === "POST") {
      if (!secretMatches(request.headers.get("X-Sync-Secret"), config.syncSecret)) return json({ ok: false, error: "unauthorized" }, 401);
      const report = await runTick(config, { fetch: (...args) => fetch(...args), force: true });
      return json(report, report.ok ? 200 : 502);
    }
    return json({ ok: false, error: "not found" }, 404);
  },
};
