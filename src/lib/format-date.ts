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

/**
 * The same date, ALWAYS absolute — «19 августа», «19 августа 2025».
 *
 * For places that need a date rather than a relative bearing: the accessible
 * name of the feed's open control reads «Открыть заметку от …», and «Открыть
 * заметку от только что» is not a sentence. It is also time-dependent, so the
 * name of a control would change while the user is on the page.
 *
 * No relative branch at all, which is why a FUTURE timestamp prints its date
 * here instead of clamping to «только что» as the relative formatter does.
 */
export function formatNoteDateFull(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const text = dayMonth.format(d);
  return d.getFullYear() === new Date(now).getFullYear() ? text : `${text} ${d.getFullYear()}`;
}

/** «14:22». `hourCycle: 'h23'`, NOT `hour12: false`.
 *
 *  They are not synonyms: `hour12: false` selects the h24 cycle in several ICU
 *  builds, which prints midnight as «24:00» — a time that does not exist and
 *  that sorts after every other hour of the day it belongs to. `h23` is the
 *  cycle Russian actually uses. Pinned by a test at exactly midnight, because
 *  this is invisible at every other hour. */
const hourMinute = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/**
 * The stamp of ONE version — «13 августа, 14:22», «13 августа 2025, 14:22».
 *
 * The version index needs a moment, not a bearing. Three versions written
 * within an hour of each other print «40 мин назад / 41 мин назад / 42 мин
 * назад» under the relative formatter: ordered, but placed nowhere — and the
 * order is already carried by the list. The clock time is what tells them
 * apart, so this formatter has no relative branch at all.
 *
 * No relative branch also means a FUTURE timestamp prints its own date here
 * rather than clamping to «только что», the same way `formatNoteDateFull`
 * behaves and for the same reason.
 */
export function formatVersionStamp(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const date = dayMonth.format(d);
  const dated = d.getFullYear() === new Date(now).getFullYear() ? date : `${date} ${d.getFullYear()}`;
  return `${dated}, ${hourMinute.format(d)}`;
}

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
