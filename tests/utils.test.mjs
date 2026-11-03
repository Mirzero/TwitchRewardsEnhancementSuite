import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tres } from './helpers.mjs';

const local = (year, month, day, hours = 0, minutes = 0) => new Date(year, month - 1, day, hours, minutes).getTime();

test('normalize collapses whitespace and trims', () => {
	assert.equal(tres.normalize('  Speedup (3h)  '), 'speedup (3h)');
	assert.equal(tres.normalize('A\n  B\tC'), 'a b c');
});

test('normalize keeps accents, so Pokémon and Pokemon stay distinct', () => {
	assert.notEqual(tres.normalize('Pokémon'), tres.normalize('Pokemon'));
	assert.equal(tres.normalize('Pokémon'), tres.normalize('Pokémon'), 'NFC folds combining accents');
});

test('a start with no timezone parses as browser-local time', () => {
	const range = tres.parseDateRange('Thu, Oct 8, 4:00 AM - Wed, Nov 4, 5:44 AM PDT', local(2026, 11, 3, 14, 41));
	assert.equal(range.start, local(2026, 10, 8, 4, 0));
	assert.equal(range.end, local(2026, 11, 4, 5, 44));
	assert.equal(range.startTz, null);
	assert.equal(range.endTz, 'PDT');
});

test('12 AM and 12 PM map to midnight and noon', () => {
	const range = tres.parseDateRange('Fri, Oct 30, 12:00 AM - Fri, Oct 30, 12:30 PM PDT', local(2026, 11, 3));
	assert.equal(range.start, local(2026, 10, 30, 0, 0));
	assert.equal(range.end, local(2026, 10, 30, 12, 30));
});

test('body date text with doubled spaces around the dash parses', () => {
	const range = tres.parseDateRange('Tue, Nov 3, 7:00 AM  -  Tue, Nov 17, 6:59 AM PDT', local(2026, 11, 3));
	assert.equal(range.start, local(2026, 11, 3, 7, 0));
});

test('a range crossing into the next year rolls the end forward', () => {
	const range = tres.parseDateRange('Mon, Dec 28, 9:00 AM - Sat, Jan 9, 8:59 AM PDT', local(2026, 12, 30));
	assert.equal(range.start, local(2026, 12, 28, 9, 0));
	assert.equal(range.end, local(2027, 1, 9, 8, 59));
});

test('early in a year, a December start belongs to the previous year', () => {
	const range = tres.parseDateRange('Mon, Dec 28, 9:00 AM - Sat, Jan 9, 8:59 AM PDT', local(2027, 1, 5));
	assert.equal(range.start, local(2026, 12, 28, 9, 0));
	assert.equal(range.end, local(2027, 1, 9, 8, 59));
});

test('year inference picks the year closest to now near the six-month boundary', () => {
	assert.equal(tres.parseDateRange('Sat, Jan 2, 9:00 AM - Sun, Jan 3, 9:00 AM', local(2026, 6, 15)).start, local(2026, 1, 2, 9, 0));
	assert.equal(tres.parseDateRange('Sat, Dec 19, 9:00 AM - Sun, Dec 20, 9:00 AM', local(2026, 6, 25)).start, local(2026, 12, 19, 9, 0));
	assert.equal(tres.parseDateRange('Sat, Dec 19, 9:00 AM - Sun, Dec 20, 9:00 AM', local(2026, 6, 10)).start, local(2025, 12, 19, 9, 0));
});

test('unparseable dates give null instead of throwing', () => {
	assert.equal(tres.parseDateRange('', 0), null);
	assert.equal(tres.parseDateRange('Coming soon', Date.now()), null);
	assert.equal(tres.parseDateRange('Mon, Foo 8, 4:00 AM - Wed, Nov 4, 5:44 AM PDT', Date.now()), null);
	assert.equal(tres.parseDateRange('Mon, Feb 30, 4:00 AM - Wed, Mar 4, 5:44 AM PDT', Date.now()), null);
});

test('campaign ids leave out the section and use parsed times', () => {
	const gameKey = tres.gameKeyOf('ARC Raiders', 'Embark Studios');
	assert.equal(gameKey, 'arc raiders|embark studios');
	assert.equal(tres.campaignIdOf(gameKey, { start: 1, end: 2 }, 'ignored'), 'arc raiders|embark studios|1|2');
	assert.equal(tres.campaignIdOf(gameKey, null, 'Some  Date'), 'arc raiders|embark studios|some date');
});
