// ── Usage-limit reset detection ──
// A "When usage limit resets" nudge watches a tab's screen for a CLI agent's
// usage-cap notice and types its text once the cap lifts. Claude Code prints
// the reset as a wall-clock time, sometimes with a date and an IANA zone:
//   "5-hour limit reached ∙ resets 3pm"
//   "You've hit your limit · resets 7:40pm (America/Los_Angeles)"
//   "Weekly limit reached ∙ resets Oct 20, 3pm (America/Los_Angeles)"
//   "Claude usage limit reached. Your limit will reset at 3pm (America/Los_Angeles)."
// Only a strict cap phrase on the same line as a reset time counts, so text
// that merely talks about rate limits never schedules anything.

const LIMIT_RE = /limit reached|hit your (?:\w+ )?limit|usage limit/i;
const RESET_RE = new RegExp(
  String.raw`(?:resets?(?:\s+at)?|try again at)\s+` +
  String.raw`(?:(?<mon>[A-Z][a-z]{2,8})\s+(?<day>\d{1,2}),?\s+(?:at\s+)?)?` +
  String.raw`(?<h>\d{1,2})(?::(?<m>\d{2}))?\s*(?<ap>am|pm)` +
  String.raw`(?:\s*\((?<tz>[A-Za-z_]+\/[A-Za-z_/]+)\))?`, 'i');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_MS = 86400000;

// Wall-clock parts of `ms` in `tz`.
function partsIn(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(ms))) p[type] = +value;
  return p;
}

// Epoch ms of a wall-clock time in `tz` (two passes settle DST edges).
function zonedToEpoch(y, mo, d, h, mi, tz) {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const p = partsIn(guess, tz);
    guess += want - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  return guess;
}

function validZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// { resetAt, line } for the first limit notice in `lines`, or null.
function findLimitReset(lines, now = Date.now()) {
  for (const line of lines) {
    if (!LIMIT_RE.test(line)) continue;
    const m = RESET_RE.exec(line);
    if (!m) continue;
    const g = m.groups;
    const tz = g.tz && validZone(g.tz) ? g.tz : Intl.DateTimeFormat().resolvedOptions().timeZone;
    const hour = (+g.h % 12) + (g.ap.toLowerCase() === 'pm' ? 12 : 0);
    const minute = +(g.m || 0);
    const today = partsIn(now, tz);
    let resetAt;
    if (g.mon) {
      const month = MONTHS.indexOf(g.mon.slice(0, 3).toLowerCase()) + 1;
      if (!month) continue;
      resetAt = zonedToEpoch(today.year, month, +g.day, hour, minute, tz);
      if (resetAt < now - DAY_MS) resetAt = zonedToEpoch(today.year + 1, month, +g.day, hour, minute, tz); // "Jan 2" seen in December
    } else {
      resetAt = zonedToEpoch(today.year, today.month, today.day, hour, minute, tz);
      if (resetAt <= now) resetAt = zonedToEpoch(today.year, today.month, today.day + 1, hour, minute, tz);
    }
    return { resetAt, line: line.trim() };
  }
  return null;
}

// The visible screen of an xterm as logical lines (soft-wrapped rows rejoined).
function screenLines(term) {
  const buf = term.buffer.active;
  const lines = [];
  for (let y = buf.viewportY; y < buf.viewportY + term.rows; y++) {
    const row = buf.getLine(y);
    if (!row) continue;
    const text = row.translateToString(true);
    if (row.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines;
}

module.exports = { findLimitReset, screenLines };
