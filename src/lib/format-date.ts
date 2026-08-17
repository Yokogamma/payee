/**
 * Dates for the feed and the version history.
 *
 * Lived inside Main.tsx and was handed down to the safebox and both history
 * modals as a prop — four callers depending on a closure defined in a screen
 * component. It is a pure function of a timestamp; it belongs here.
 *
 * THE SHAPE, and why each part is the way it is:
 *
 *   < 1 min      «только что»
 *   < 1 hour     «5 мин назад»
 *   < 24 hours   «3 ч назад»
 *   this year    «9 августа»
 *   earlier      «9 августа 2025»
 *
 * The relative window stays because a note written twenty minutes ago is
 * placed by «20 мин назад» and not by a date — the reader knows what day it
 * is. Past that, relative time stops helping and starts hiding: «43 дня
 * назад» is a subtraction the reader has to perform.
 *
 * THE YEAR IS NOT DROPPED. The previous formatter kept it and the redesign
 * mockups only ever show this year's notes, so it would have been easy to
 * follow them into «9 августа» for a 2019 entry. This is an archive whose
 * whole promise is that things stay forever; a date that silently means «some
 * August» is the one kind of ambiguity it cannot afford.
 *
 * A FUTURE timestamp clamps to «только что». It happens — a device with a
 * skewed clock writes a note, then the clock corrects — and every alternative
 * is worse: «-3 ч назад» is broken, and «через 3 часа» tells the reader their
 * note is scheduled, which it is not.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** «9 августа» — genitive, which is what a day-and-month reads as in Russian.
 *  `toLocaleString('ru', { month: 'long' })` alone yields the nominative
 *  «август», so the day has to be in the same format call to inflect it. */
const dayMonth = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' });

export function formatNoteDate(ts: number, now: number = Date.now()): string {
  const diff = now - ts;

  if (diff < MINUTE) return 'только что';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} мин назад`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} ч назад`;

  const d = new Date(ts);
  const text = dayMonth.format(d);
  // `year: 'numeric'` in the formatter above would append « г.», which reads
  // as noise in a mono uppercase label. The year is joined by hand instead.
  return d.getFullYear() === new Date(now).getFullYear() ? text : `${text} ${d.getFullYear()}`;
}
