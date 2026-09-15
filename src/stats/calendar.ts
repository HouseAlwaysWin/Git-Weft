/**
 * Calendar days as plain numbers, for cutting a history into weeks or months.
 *
 * A day is `YYYYMMDD` - 20260115 - because that is what the front of git's `%aI` already says, on the
 * author's own calendar: the day the graph's row shows. Arithmetic on days goes through a count of them
 * rather than through `Date`, which answers every question in the reader's time zone, daylight saving
 * and all.
 */

/** What one bar stands for. */
export type Unit = 'week' | 'month';

/**
 * The most weeks drawn a bar each. A history spanning more is counted by the month.
 *
 * Sixty is a little over a year. Past it a week's bar on an ordinary editor is a few pixels wide and the
 * chart turns to texture, while a month's still reads - and a history that long is looked at for its
 * seasons rather than its weeks.
 */
export const MOST_WEEKS = 60;

/** English whatever the machine's locale, like the rest of the interface: a chart is the same chart everywhere. */
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export function yearOf(day: number): number {
  return Math.floor(day / 10_000);
}

export function monthOf(day: number): number {
  return Math.floor(day / 100) % 100;
}

export function dateOf(day: number): number {
  return day % 100;
}

export function dayFrom(year: number, month: number, date: number): number {
  return year * 10_000 + month * 100 + date;
}

/** How many days a month has: 29 for February in a leap year. */
export function monthLength(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }

  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * Days since 1970-01-01.
 *
 * Howard Hinnant's `days_from_civil`: whole numbers only, over a year that starts in March, so that a
 * leap day is the last day of its year and needs no case of its own.
 */
export function serialOf(day: number): number {
  const month = monthOf(day);
  const year = yearOf(day) - (month <= 2 ? 1 : 0);
  const era = Math.floor(year / 400);
  const yearOfEra = year - era * 400;
  const dayOfYear = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + dateOf(day) - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;

  return era * 146_097 + dayOfEra - 719_468;
}

/** The day a count of days since 1970-01-01 lands on: `civil_from_days`, the same steps backwards. */
export function dayFromSerial(serial: number): number {
  const shifted = serial + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const fromMarch = Math.floor((5 * dayOfYear + 2) / 153);
  const date = dayOfYear - Math.floor((153 * fromMarch + 2) / 5) + 1;
  const month = fromMarch < 10 ? fromMarch + 3 : fromMarch - 9;

  return dayFrom(yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, date);
}

/** Monday 0 to Sunday 6. Day 0, 1970-01-01, was a Thursday. */
export function weekdayOf(serial: number): number {
  return (((serial + 3) % 7) + 7) % 7;
}

/**
 * The Monday a day's week starts on.
 *
 * ISO 8601's week, and the working week of most people reading this. Weeks starting on a Sunday would cut
 * every weekend in two, half of it on the end of one bar and half on the front of the next.
 */
export function weekStart(day: number): number {
  const serial = serialOf(day);
  return dayFromSerial(serial - weekdayOf(serial));
}

/** Months since the start of year 0, for counting how many lie between two days. */
function monthsOf(day: number): number {
  return yearOf(day) * 12 + monthOf(day) - 1;
}

/** Weeks while the history spans few enough of them for a bar each, and months once it does not. */
export function unitFor(first: number, last: number): Unit {
  const weeks = (serialOf(weekStart(last)) - serialOf(weekStart(first))) / 7 + 1;
  return weeks <= MOST_WEEKS ? 'week' : 'month';
}

/** The first day of every bar, from the bar holding `first` to the bar holding `last`. */
export function bucketStarts(first: number, last: number, unit: Unit): number[] {
  const starts: number[] = [];

  if (unit === 'week') {
    const end = serialOf(weekStart(last));

    for (let serial = serialOf(weekStart(first)); serial <= end; serial += 7) {
      starts.push(dayFromSerial(serial));
    }
  } else {
    const end = monthsOf(last);

    for (let months = monthsOf(first); months <= end; months++) {
      starts.push(dayFrom(Math.floor(months / 12), (months % 12) + 1, 1));
    }
  }

  return starts;
}

/** Which bar a day is in, counting from the bar that starts on `firstStart`. */
export function bucketIndex(day: number, firstStart: number, unit: Unit): number {
  return unit === 'week'
    ? Math.floor((serialOf(day) - serialOf(firstStart)) / 7)
    : monthsOf(day) - monthsOf(firstStart);
}

/** A bar's name in a sentence: "November 2025", or "the week of 3 November 2025". */
export function describeBucket(start: number, unit: Unit): string {
  const month = MONTHS[monthOf(start) - 1] ?? '';

  return unit === 'month'
    ? `${month} ${yearOf(start)}`
    : `the week of ${dateOf(start)} ${month} ${yearOf(start)}`;
}

/**
 * An axis label: "Nov", or "3 Nov" for a week, and the year after it when `withYear` says so. Which labels
 * need a year depends on the labels beside them, so that is the chart's to decide.
 */
export function tickLabel(start: number, unit: Unit, withYear: boolean): string {
  const month = (MONTHS[monthOf(start) - 1] ?? '').slice(0, 3);
  const text = unit === 'month' ? month : `${dateOf(start)} ${month}`;

  return withYear ? `${text} ${yearOf(start)}` : text;
}
