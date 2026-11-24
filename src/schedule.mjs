// When the keeper acts. All decisions use the wall clock of config.timeZone, so the window follows
// daylight-saving changes without touching the (UTC-only) cron.

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map();

function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    );
  }
  return formatters.get(timeZone);
}

// { dow: 1..7 (ISO), minutes: minutes since local midnight, label: "Tue 19:40" }
export function localTime(date, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(date).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return { dow: WEEKDAYS[parts.weekday], minutes: hour * 60 + minute, label: `${parts.weekday} ${parts.hour}:${parts.minute}` };
}

// minutes since the window opened, or null outside it. A window like 22:00-06:00 wraps midnight and
// then belongs to the weekday it started on.
function minutesIntoWindow(local, config) {
  const { start, end } = config.hours;
  if (start < end) {
    return config.days.has(local.dow) && local.minutes >= start && local.minutes < end ? local.minutes - start : null;
  }
  if (local.minutes >= start) return config.days.has(local.dow) ? local.minutes - start : null;
  if (local.minutes < end) {
    const prevDow = local.dow === 1 ? 7 : local.dow - 1;
    return config.days.has(prevDow) ? 24 * 60 - start + local.minutes : null;
  }
  return null;
}

export function isActive(date, config) {
  return minutesIntoWindow(localTime(date, config.timeZone), config) !== null;
}

// sync on the first tick of the window and then every syncEveryMin. A tick may arrive a little late
// (cron jitter), so the slot is "the first tick at or after each multiple".
export function isSyncTick(date, config) {
  if (!config.syncEveryMin) return false;
  const into = minutesIntoWindow(localTime(date, config.timeZone), config);
  return into !== null && into % config.syncEveryMin < config.tickMin;
}
