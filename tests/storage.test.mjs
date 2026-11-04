import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tres, extractSample } from './helpers.mjs';

const DAY = 24 * 60 * 60 * 1000;

test('missing or corrupt stored data gives the defaults without throwing', () => {
	const defaults = tres.defaultData();
	for (const raw of [null, undefined, 'not json', '{"schema":1}', 42, [], { schema: 2, rules: 'nope' }]) {
		assert.deepEqual(tres.sanitizeData(raw), defaults, JSON.stringify(raw));
	}
	assert.deepEqual(tres.loadData({ read: () => { throw new Error('boom'); } }), defaults);
	assert.equal(defaults.rules.hideClosed, true);
	assert.equal(defaults.rules.hideUpcoming, false);
	assert.equal(defaults.rules.showHidden, false);
});

test('sanitize keeps valid values and normalizes reward types', () => {
	const data = tres.sanitizeData({ schema: 2, rules: { hideClosed: false, hiddenRewardTypes: ['Badge', 'badge', 3] }, claimed: { k: {} } });
	assert.equal(data.rules.hideClosed, false);
	assert.deepEqual(data.rules.hiddenRewardTypes, ['badge']);
	assert.deepEqual(data.claimed, { k: {} });
});

test('mergeImport unions rules and claimed marks, toggles come from the backup', () => {
	const current = tres.defaultData();
	current.rules.hiddenGames.a = { game: 'A' };
	current.rules.hiddenRewardTypes = ['badge'];
	current.claimed.x = { campaignId: 'c1' };
	const backup = tres.defaultData();
	backup.rules.hideClosed = false;
	backup.rules.hiddenGames.b = { game: 'B' };
	backup.rules.hiddenPublishers.p = { publisher: 'P' };
	backup.rules.hiddenRewardTypes = ['in-game item'];
	backup.claimed.y = { campaignId: 'c2' };
	const merged = tres.mergeImport(current, backup);
	assert.deepEqual(Object.keys(merged.rules.hiddenGames).sort(), ['a', 'b']);
	assert.deepEqual(Object.keys(merged.rules.hiddenPublishers), ['p']);
	assert.deepEqual(merged.rules.hiddenRewardTypes.sort(), ['badge', 'in-game item']);
	assert.deepEqual(Object.keys(merged.claimed).sort(), ['x', 'y']);
	assert.equal(merged.rules.hideClosed, false);
	assert.deepEqual(Object.keys(current.rules.hiddenGames), ['a'], 'the current data is not mutated');
});

test('mergeImport keeps the newer stored rewards for a campaign', () => {
	const current = tres.defaultData();
	current.campaigns.c = { firstSeen: 5, lastSeen: 50, rewardsSeenAt: 10, rewards: [{ key: 'old' }] };
	const backup = tres.defaultData();
	backup.campaigns.c = { firstSeen: 1, lastSeen: 20, rewardsSeenAt: 30, rewards: [{ key: 'new' }] };
	backup.campaigns.d = { firstSeen: 2, rewards: null };
	const merged = tres.mergeImport(current, backup);
	assert.deepEqual(merged.campaigns.c.rewards, [{ key: 'new' }]);
	assert.equal(merged.campaigns.c.firstSeen, 1);
	assert.equal(merged.campaigns.c.lastSeen, 50);
	assert.ok(merged.campaigns.d);
});

test('export then import into empty storage reproduces the same state', () => {
	const data = tres.defaultData();
	data.rules.hideClosed = false;
	data.rules.showHidden = true;
	data.rules.hiddenCampaigns.c = { game: 'G', publisher: 'P', dateText: 'd', title: null, hiddenAt: 1 };
	data.rules.hiddenRewardTypes = ['badge'];
	data.claimed.k = { name: 'n', campaignId: 'c', claimedAt: 2 };
	data.campaigns.c = { firstSeen: 1, lastSeen: 2, end: 3, title: 't', redeem: ['watch'], connection: 'none', rewardsSeenAt: 4, rewards: [] };
	data.lastExportAt = 9;
	const exported = JSON.stringify(data);
	assert.deepEqual(tres.mergeImport(tres.defaultData(), JSON.parse(exported)), data);
});

test('prune removes long-ended, long-unseen campaigns and their claims, never rules', () => {
	const now = 1000 * DAY;
	const data = tres.defaultData();
	data.campaigns.old = { end: now - 61 * DAY, lastSeen: now - 61 * DAY };
	data.campaigns.recentlySeen = { end: now - 61 * DAY, lastSeen: now - DAY };
	data.campaigns.active = { end: now + DAY, lastSeen: now - 90 * DAY };
	data.claimed.a = { campaignId: 'old' };
	data.claimed.b = { campaignId: 'active' };
	data.rules.hiddenCampaigns.old = { game: 'G' };
	assert.equal(tres.prune(data, now), 1);
	assert.deepEqual(Object.keys(data.campaigns).sort(), ['active', 'recentlySeen']);
	assert.deepEqual(Object.keys(data.claimed), ['b']);
	assert.ok(data.rules.hiddenCampaigns.old);
});

test('learned rewards are stored and reused when a body is not loaded', () => {
	const data = tres.defaultData();
	const open = extractSample('page_source_opencampaigns.html');
	assert.equal(tres.learnCampaigns(open.campaigns, data, open.now), true);
	assert.equal(Object.keys(data.campaigns).length, 102);
	assert.equal(tres.learnCampaigns(open.campaigns, data, open.now + 1000), false, 'no changes means no write');

	const collapsed = extractSample('page_source_default.html');
	tres.learnCampaigns(collapsed.campaigns, data, collapsed.now);
	const enshrouded = collapsed.campaigns.find((c) => c.game === 'Enshrouded');
	assert.equal(enshrouded.bodyLoaded, false);
	assert.equal(enshrouded.rewardsSource, 'stored');
	assert.equal(enshrouded.rewards.length, 6);
	assert.equal(enshrouded.title, 'Enshrouded Artificer');
	assert.equal(collapsed.campaigns.filter((c) => c.rewards).length, 102);

	for (const reward of enshrouded.rewards) data.claimed[reward.key] = { campaignId: enshrouded.id };
	assert.equal(tres.hideReason(enshrouded, data.rules, data.claimed), 'rewards');
});

test('stored data survives a JSON round trip (what Tampermonkey storage does)', () => {
	const data = tres.defaultData();
	const open = extractSample('page_source_opencampaigns.html');
	tres.learnCampaigns(open.campaigns, data, open.now);
	const storage = tres.memoryStorage();
	storage.write(data);
	assert.deepEqual(tres.loadData(storage), data);
});

test('sortBy defaults to newest, rejects unknown values, and comes from an imported backup', () => {
	assert.equal(tres.defaultData().rules.sortBy, 'newest');
	assert.equal(tres.sanitizeData({ schema: 2, rules: { sortBy: 'random' } }).rules.sortBy, 'newest');
	assert.equal(tres.sanitizeData({ schema: 2, rules: { sortBy: 'ending' } }).rules.sortBy, 'ending');
	const backup = tres.defaultData();
	backup.rules.sortBy = 'game';
	assert.equal(tres.mergeImport(tres.defaultData(), backup).rules.sortBy, 'game');
});
