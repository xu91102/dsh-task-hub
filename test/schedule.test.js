/**
 * Cron parser + next-run computation checks.
 *
 * The grammar is ported from dsh-web-ui's schedule.ts; these pin the shared
 * semantics regardless of the timezone the test runs under (all comparisons are
 * made against the same local-clock construction that `nextRunAtMs` uses).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { isValidCron, nextRunAtMs, parseCron } from '../lib/schedule.js'

/** Make an epoch-ms instant at local wall-clock (y,m,d,h,min,0,0). */
function at(y, m, d, h, min) {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime()
}

test('a valid 5-field expression parses and an invalid one does not', () => {
  assert.ok(isValidCron('0 9 * * *'))
  assert.ok(isValidCron('*/10 * * * *'))
  assert.ok(isValidCron('0 9 * * 1'))
  assert.ok(isValidCron('0 0 30 2 *'))
  assert.ok(isValidCron('1,15,30 0-12 * * 0'))
  assert.equal(isValidCron(''), false)
  assert.equal(isValidCron('0 9 * *'), false)
  assert.equal(isValidCron('60 9 * * *'), false)
  assert.equal(isValidCron('0 24 * * *'), false)
  assert.equal(isValidCron('0 9 32 * *'), false)
  assert.equal(isValidCron('0 9 * 13 *'), false)
  assert.equal(isValidCron('0 9 * * 8'), false)
})

test('wildcards enumerate the full field range', () => {
  const schedule = parseCron('* * * * *')
  assert.equal(schedule.minutes.size, 60)
  assert.equal(schedule.hours.size, 24)
  assert.equal(schedule.weekdays.size, 7) // 7 normalized to 0 = Sunday
  assert.equal(schedule.dayWildcard, true)
  assert.equal(schedule.weekdayWildcard, true)
})

test('weekday 7 normalizes to 0 (Sunday)', () => {
  const schedule = parseCron('0 0 * * 7')
  assert.ok(schedule.weekdays.has(0))
  assert.ok(!schedule.weekdays.has(7))
})

test('next run for a daily time is the next matching local minute', () => {
  // From 09:00 exactly, 0 9 * * * next lands tomorrow 09:00 (strictly later).
  const from = at(2026, 1, 1, 9, 0)
  assert.equal(nextRunAtMs('0 9 * * *', from), at(2026, 1, 2, 9, 0))
  // From the minute before, it lands on today's 09:00.
  assert.equal(nextRunAtMs('0 9 * * *', at(2026, 1, 1, 8, 59)), at(2026, 1, 1, 9, 0))
})

test('step fields advance by the step amount', () => {
  const from = at(2026, 1, 1, 0, 0)
  assert.equal(nextRunAtMs('*/15 * * * *', from), at(2026, 1, 1, 0, 15))
  assert.equal(nextRunAtMs('*/15 * * * *', at(2026, 1, 1, 0, 15)), at(2026, 1, 1, 0, 30))
})

test('restricted day and weekday combine with OR semantics', () => {
  // From Friday 2027-01-01 09:00, "day 1 OR Monday at 09:00" next lands on
  // Monday 2027-01-04 — earlier than the next month-first (Feb 1).
  const from = at(2027, 1, 1, 9, 0)
  assert.equal(new Date(from).getDay(), 5, 'the fixture start is a Friday')
  assert.equal(nextRunAtMs('0 9 1 * 1', from), at(2027, 1, 4, 9, 0))
})

test('an impossible expression yields undefined (no match in 366 days)', () => {
  assert.equal(nextRunAtMs('0 0 30 2 *', at(2026, 3, 1, 0, 0)), undefined)
})
