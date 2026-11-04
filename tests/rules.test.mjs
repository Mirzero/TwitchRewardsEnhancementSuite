import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tres, extractSample } from './helpers.mjs';

const model = () => extractSample('page_source_opencampaigns.html').campaigns;
const hiddenBy = (campaigns, data) => campaigns.filter((c) => tres.hideReason(c, data.rules, data.claimed));
const games = (list) => list.map((c) => c.game).sort();
const claimAll = (data, campaign, count = campaign.rewards.length) => {
	for (const reward of campaign.rewards.slice(0, count)) data.claimed[reward.key] = { name: reward.name, campaignId: campaign.id, claimedAt: 1 };
};

test('defaults: hide closed is on, so exactly the 18 Closed campaigns are hidden', () => {
	const campaigns = model();
	const data = tres.defaultData();
	const hidden = hiddenBy(campaigns, data);
	assert.equal(hidden.length, 18);
	assert.ok(hidden.every((c) => c.type === 'Closed Drop Campaign'));
	assert.ok(hidden.every((c) => tres.hideReason(c, data.rules, data.claimed) === 'closed'));
});

test('everything else is shown by default', () => {
	const data = tres.defaultData();
	data.rules.hideClosed = false;
	assert.equal(hiddenBy(model(), data).length, 0);
});

test('hiding the Badge type hides exactly the badge-only campaigns', () => {
	const data = tres.defaultData();
	data.rules.hideClosed = false;
	data.rules.hiddenRewardTypes = ['badge'];
	const hidden = hiddenBy(model(), data);
	assert.deepEqual(games(hidden), ['Dead by Daylight', 'ELDEN RING', 'QSMP']);
	assert.ok(hidden.every((c) => tres.hideReason(c, data.rules, data.claimed) === 'rewards'));
});

test('League of Legends (Badge + In-Game Item) stays visible with Badge hidden', () => {
	const data = tres.defaultData();
	data.rules.hiddenRewardTypes = ['badge'];
	const lol = model().find((c) => c.game === 'League of Legends');
	assert.equal(tres.hideReason(lol, data.rules, data.claimed), null);
});

test('marking all 6 Enshrouded rewards claimed hides it; marking 5 does not', () => {
	const enshrouded = model().find((c) => c.game === 'Enshrouded');
	const five = tres.defaultData();
	claimAll(five, enshrouded, 5);
	assert.equal(tres.hideReason(enshrouded, five.rules, five.claimed), null);
	const six = tres.defaultData();
	claimAll(six, enshrouded);
	assert.equal(tres.hideReason(enshrouded, six.rules, six.claimed), 'rewards');
});

test('mixed case: Badge hidden plus Flex On Em claimed hides League of Legends', () => {
	const lol = model().find((c) => c.game === 'League of Legends');
	const data = tres.defaultData();
	data.rules.hiddenRewardTypes = ['badge'];
	const flex = lol.rewards.find((r) => r.name === 'Flex On Em');
	data.claimed[flex.key] = { name: flex.name, campaignId: lol.id, claimedAt: 1 };
	assert.equal(tres.rewardDone(flex, data.rules, data.claimed), true);
	assert.equal(tres.hideReason(lol, data.rules, data.claimed), 'rewards');
});

test('a campaign with unknown rewards is never hidden by the rewards rule', () => {
	const campaign = extractSample('page_source_default.html').campaigns.find((c) => c.game === 'QSMP');
	const data = tres.defaultData();
	data.rules.hiddenRewardTypes = ['badge'];
	assert.equal(campaign.rewards, null);
	assert.equal(tres.hideReason(campaign, data.rules, data.claimed), null);
});

test('hiding a game hides its campaigns in every section', () => {
	const campaigns = model();
	const data = tres.defaultData();
	data.rules.hideClosed = false;
	data.rules.hiddenGames['overwatch|blizzard'] = { game: 'Overwatch', publisher: 'Blizzard' };
	const hidden = hiddenBy(campaigns, data);
	assert.equal(hidden.length, 2);
	assert.deepEqual(hidden.map((c) => c.type).sort(), ['Closed Drop Campaign', 'Open Drop Campaign']);
	assert.ok(hidden.every((c) => tres.hideReason(c, data.rules, data.claimed) === 'game'));
});

test('hiding a publisher hides all of its campaigns in every section', () => {
	const campaigns = model();
	const data = tres.defaultData();
	data.rules.hideClosed = false;
	data.rules.hiddenPublishers.blizzard = { publisher: 'Blizzard' };
	const expected = campaigns.filter((c) => c.publisher === 'Blizzard');
	assert.ok(expected.some((c) => c.type === 'Closed Drop Campaign') && expected.some((c) => c.type !== 'Closed Drop Campaign'));
	assert.deepEqual(hiddenBy(campaigns, data).map((c) => c.id).sort(), expected.map((c) => c.id).sort());
});

test('hiding one campaign id hides exactly one campaign', () => {
	const campaigns = model();
	const data = tres.defaultData();
	data.rules.hideClosed = false;
	const target = campaigns.find((c) => c.game === 'Overwatch' && c.type !== 'Closed Drop Campaign');
	data.rules.hiddenCampaigns[target.id] = { game: target.game };
	assert.deepEqual(hiddenBy(campaigns, data).map((c) => c.id), [target.id]);
});

test('reward types are matched case-insensitively', () => {
	const reward = { key: 'k', type: 'In-Game Item' };
	const data = tres.defaultData();
	data.rules.hiddenRewardTypes = ['in-game item'];
	assert.equal(tres.rewardDone(reward, data.rules, data.claimed), true);
});

// ---------------------------------------------------------------------------
// Sorting (spec §4.6)
// ---------------------------------------------------------------------------

const openOf = (name) => extractSample(name).campaigns.filter((c) => c.type === 'Open Drop Campaign');

test('twitch order keeps the extracted order, which is oldest start first', () => {
	const open = openOf('page_source_default.html');
	assert.deepEqual(tres.sortCampaigns(open, 'twitch'), open);
	assert.ok(open.every((c, i) => i === 0 || c.start >= open[i - 1].start));
});

test('newest puts the latest start first', () => {
	const sorted = tres.sortCampaigns(openOf('page_source_default.html'), 'newest');
	assert.equal(sorted[0].game, 'Rise Online');
	assert.ok(sorted.every((c, i) => i === 0 || c.start <= sorted[i - 1].start));
});

test('ending puts the earliest end first', () => {
	const sorted = tres.sortCampaigns(openOf('page_source_default.html'), 'ending');
	assert.ok(sorted.every((c, i) => i === 0 || c.end >= sorted[i - 1].end));
});

test('game and publisher sort alphabetically, ignoring case', () => {
	const open = openOf('page_source_default.html');
	const games = tres.sortCampaigns(open, 'game').map((c) => c.game);
	assert.deepEqual(games, [...games].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
	assert.equal(games[0].localeCompare(games.at(-1), undefined, { sensitivity: 'base' }) < 0, true);
	const publishers = tres.sortCampaigns(open, 'publisher').map((c) => c.publisher);
	assert.deepEqual(publishers, [...publishers].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
});

test('ties keep Twitch order and undated campaigns go last', () => {
	const make = (game, start) => ({ game, publisher: 'P', start, end: start });
	const list = [make('a', null), make('b', 5), make('c', 5), make('d', 9)];
	assert.deepEqual(tres.sortCampaigns(list, 'newest').map((c) => c.game), ['d', 'b', 'c', 'a']);
	assert.deepEqual(tres.sortCampaigns(list, 'ending').map((c) => c.game), ['b', 'c', 'd', 'a']);
	assert.deepEqual(tres.sortCampaigns(list, 'publisher').map((c) => c.game), ['a', 'b', 'c', 'd']);
});

test('displayOrder puts visible campaigns first and dimmed ones last, each group in sort order', () => {
	const make = (game, start, dimmed) => ({ game, publisher: 'P', start, end: start, dimmed });
	const list = [make('a', 1, false), make('b', 2, true), make('c', 3, false), make('d', 4, true)];
	const order = (sortBy) => tres.displayOrder(list, sortBy, (c) => c.dimmed).map((c) => c.game);
	assert.deepEqual(order('newest'), ['c', 'a', 'd', 'b']);
	assert.deepEqual(order('twitch'), ['a', 'c', 'b', 'd']);
	assert.deepEqual(tres.displayOrder(list, 'newest', () => false).map((c) => c.game), ['d', 'c', 'b', 'a'], 'nothing dimmed: plain sort');
});
