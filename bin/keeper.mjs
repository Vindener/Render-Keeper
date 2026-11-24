#!/usr/bin/env node
// Node runner for the same keeper logic (any always-on machine: VPS, Raspberry Pi, systemd, cron).
//
//   node --env-file=.env bin/keeper.mjs            one tick now (what cron would do), exit 1 if it needs attention
//   node --env-file=.env bin/keeper.mjs --loop     tick every TICK_MIN minutes, aligned to the clock
//   node --env-file=.env bin/keeper.mjs --force    wake + sync now, ignoring the window
//   node --env-file=.env bin/keeper.mjs --dry-run  only print the decision for now, no requests
//   --now 2026-11-17T17:40:00Z                     pretend it is that moment (testing)
import { writeFile } from "node:fs/promises";
import { ConfigError, loadConfig, publicConfig } from "../src/config.mjs";
import { runTick } from "../src/keeper.mjs";
import { isActive, isSyncTick, localTime } from "../src/schedule.mjs";

function parseArgs(argv) {
  const args = { loop: false, force: false, dryRun: false, now: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--loop") args.loop = true;
    else if (a === "--force") args.force = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--now") args.now = new Date(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new ConfigError(`unknown argument ${a}`);
  }
  if (args.now && Number.isNaN(args.now.getTime())) throw new ConfigError("--now must be an ISO date");
  if (args.loop && args.now) throw new ConfigError("--now cannot be combined with --loop");
  return args;
}

async function tick(config, args) {
  const now = args.now ?? new Date();
  if (args.dryRun) {
    const report = { at: now.toISOString(), local: localTime(now, config.timeZone).label, active: isActive(now, config), syncTick: isSyncTick(now, config), config: publicConfig(config), ok: true };
    console.log(JSON.stringify(report));
    return report;
  }
  const report = await runTick(config, { now, fetch: globalThis.fetch, force: args.force });
  console.log(JSON.stringify(report));
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node [--env-file=.env] bin/keeper.mjs [--loop | --force | --dry-run] [--now ISO]");
    return 0;
  }
  const config = loadConfig(process.env);
  if (!args.loop) return (await tick(config, args)).ok ? 0 : 1;

  console.error(`keeper loop: every ${config.tickMin} min, window ${config.hoursText} days ${config.daysText} (${config.timeZone})`);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => (stopping = true));
  const step = config.tickMin * 60 * 1000;
  // HEARTBEAT_FILE (Docker HEALTHCHECK): touched after every tick, so a stuck loop shows as unhealthy
  const heartbeat = process.env.HEARTBEAT_FILE;
  while (!stopping) {
    await tick(config, args).catch((err) => console.error("tick failed:", err));
    if (heartbeat) await writeFile(heartbeat, new Date().toISOString()).catch((err) => console.error("heartbeat failed:", err.message));
    // sleep to the next clock-aligned tick, waking every second to notice a stop signal
    const next = Math.floor(Date.now() / step) * step + step;
    while (!stopping && Date.now() < next) await new Promise((r) => setTimeout(r, Math.min(1000, next - Date.now())));
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof ConfigError ? `config error: ${err.message}` : err);
    process.exit(2);
  }
);
