import test from "node:test";
import assert from "node:assert/strict";
import { ConfigError, loadConfig, parseDays, publicConfig } from "../src/config.mjs";
import { isActive, isSyncTick, localTime } from "../src/schedule.mjs";

const base = { BACKEND_URL: "https://api.example.test/api/" };
const cfg = (extra = {}) => loadConfig({ ...base, ...extra });

test("config defaults and normalisation", () => {
  const c = cfg();
  assert.equal(c.backendUrl, "https://api.example.test/api");
  assert.equal(c.timeZone, "Europe/Kyiv");
  assert.deepEqual(c.hours, { start: 8 * 60, end: 22 * 60 });
  assert.deepEqual([...c.days].sort(), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(c.syncSecret, null);
  assert.equal(c.syncEveryMin, 30);
  assert.equal(publicConfig(cfg({ SYNC_SECRET: "s3cret" })).syncSecretSet, true);
  assert.ok(!JSON.stringify(publicConfig(cfg({ SYNC_SECRET: "s3cret" }))).includes("s3cret"), "public config must not leak the secret");
});

test("config rejects bad values", () => {
  assert.throws(() => loadConfig({}), ConfigError);
  assert.throws(() => cfg({ BACKEND_URL: "not a url" }), ConfigError);
  assert.throws(() => cfg({ BACKEND_URL: "ftp://x/api" }), ConfigError);
  assert.throws(() => cfg({ TIMEZONE: "Mars/Olympus" }), ConfigError);
  assert.throws(() => cfg({ ACTIVE_HOURS: "8-22" }), ConfigError);
  assert.throws(() => cfg({ ACTIVE_HOURS: "08:00-08:00" }), ConfigError);
  assert.throws(() => cfg({ ACTIVE_HOURS: "25:00-08:00" }), ConfigError);
  assert.throws(() => cfg({ ACTIVE_DAYS: "0-5" }), ConfigError);
  assert.throws(() => cfg({ ACTIVE_DAYS: "5-1" }), ConfigError);
  assert.throws(() => cfg({ SYNC_EVERY_MIN: "25" }), ConfigError, "sync cadence must be a multiple of the tick");
  assert.throws(() => cfg({ TICK_MIN: "0" }), ConfigError);
  assert.equal(cfg({ SYNC_EVERY_MIN: "0" }).syncEveryMin, 0);
  assert.deepEqual([...parseDays("1-3, 7")].sort(), [1, 2, 3, 7]);
});

test("Kyiv local time follows winter (UTC+2) and summer (UTC+3) time", () => {
  assert.deepEqual(localTime(new Date("2026-11-17T06:00:00Z"), "Europe/Kyiv"), { dow: 2, minutes: 8 * 60, label: "Tue 08:00" });
  assert.deepEqual(localTime(new Date("2026-07-14T05:00:00Z"), "Europe/Kyiv"), { dow: 2, minutes: 8 * 60, label: "Tue 08:00" });
  // midnight is 00, not 24
  assert.equal(localTime(new Date("2026-11-17T22:00:00Z"), "Europe/Kyiv").label, "Wed 00:00");
});

test("default window 08:00-22:00 Kyiv, end exclusive", () => {
  const c = cfg();
  assert.equal(isActive(new Date("2026-11-17T05:50:00Z"), c), false, "07:50 winter");
  assert.equal(isActive(new Date("2026-11-17T06:00:00Z"), c), true, "08:00 winter");
  assert.equal(isActive(new Date("2026-11-17T19:50:00Z"), c), true, "21:50 winter");
  assert.equal(isActive(new Date("2026-11-17T20:00:00Z"), c), false, "22:00 winter");
  assert.equal(isActive(new Date("2026-07-14T04:50:00Z"), c), false, "07:50 summer");
  assert.equal(isActive(new Date("2026-07-14T05:00:00Z"), c), true, "08:00 summer");
  assert.equal(isActive(new Date("2026-07-14T18:50:00Z"), c), true, "21:50 summer");
  assert.equal(isActive(new Date("2026-07-14T19:00:00Z"), c), false, "22:00 summer");
});

test("DST switch days (last Sunday of March / October)", () => {
  const c = cfg();
  // 2026-03-29: clocks go 03:00 -> 04:00; 05:00Z is 08:00 EEST
  assert.equal(isActive(new Date("2026-03-29T04:50:00Z"), c), false);
  assert.equal(isActive(new Date("2026-03-29T05:00:00Z"), c), true);
  // the day before it was still UTC+2: 05:00Z = 07:00
  assert.equal(isActive(new Date("2026-03-28T05:00:00Z"), c), false);
  // 2026-10-25: back to UTC+2; 06:00Z = 08:00 EET, 05:00Z = 07:00
  assert.equal(isActive(new Date("2026-10-25T05:00:00Z"), c), false);
  assert.equal(isActive(new Date("2026-10-25T06:00:00Z"), c), true);
});

test("weekday filter and midnight-wrapping window", () => {
  const weekdays = cfg({ ACTIVE_DAYS: "1-5" });
  assert.equal(isActive(new Date("2026-11-21T10:00:00Z"), weekdays), false, "Saturday");
  assert.equal(isActive(new Date("2026-11-20T10:00:00Z"), weekdays), true, "Friday");
  const night = cfg({ ACTIVE_HOURS: "22:00-02:00", ACTIVE_DAYS: "5" });
  assert.equal(isActive(new Date("2026-11-20T21:00:00Z"), night), true, "Fri 23:00");
  assert.equal(isActive(new Date("2026-11-20T23:30:00Z"), night), true, "Sat 01:30 belongs to Friday's window");
  assert.equal(isActive(new Date("2026-11-21T21:00:00Z"), night), false, "Sat 23:00");
  assert.equal(isActive(new Date("2026-11-20T00:30:00Z"), night), false, "Fri 02:30 belongs to Thursday's window");
});

test("sync ticks: window start and every 30 min, tolerant to late cron", () => {
  const c = cfg();
  const at = (kyiv) => new Date(`2026-11-17T${kyiv}:00+02:00`);
  const syncs = [];
  for (let m = 7 * 60; m < 23 * 60; m += 10) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    if (isSyncTick(at(`${hh}:${mm}`), c)) syncs.push(`${hh}:${mm}`);
  }
  assert.equal(syncs[0], "08:00");
  assert.equal(syncs.at(-1), "21:30");
  assert.equal(syncs.length, 28, "08:00..21:30 every 30 min");
  assert.equal(isSyncTick(at("08:31"), c), true, "a late 08:30 tick still syncs");
  assert.equal(isSyncTick(at("08:41"), c), false);
  assert.equal(isSyncTick(at("07:30"), c), false, "never outside the window");
  assert.equal(isSyncTick(at("08:00"), cfg({ SYNC_EVERY_MIN: "0" })), false, "0 disables sync");
});
