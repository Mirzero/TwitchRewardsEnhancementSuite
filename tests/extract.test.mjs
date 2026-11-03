import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tres, extractSample, loadSample, byGame, headerOf } from './helpers.mjs';

const local = (year, month, day, hours = 0, minutes = 0) => new Date(year, month - 1, day, hours, minutes).getTime();
const ids = (result) => result.campaigns.map((campaign) => campaign.id).sort();
const count = (list, predicate) => list.filter(predicate).length;

test('default sample: 102 campaigns, no failures, all headings recognised', () => {
	const result = extractSample('page_source_default.html');
	assert.equal(result.found, true);
	assert.equal(result.recognized, true);
	assert.equal(result.diagnostics.headers, 102);
	assert.equal(result.campaigns.length, 102);
	assert.deepEqual(result.diagnostics.failures, []);
	assert.deepEqual(result.diagnostics.unknownHeadings, []);
	assert.equal(result.diagnostics.dateFailures, 0);
});

test('default sample: 84 Open Drop and 18 Closed Drop, missing Open Reward section is fine', () => {
	const { campaigns } = extractSample('page_source_default.html');
	assert.equal(count(campaigns, (c) => c.type === 'Open Drop Campaign'), 84);
	assert.equal(count(campaigns, (c) => c.type === 'Closed Drop Campaign'), 18);
	assert.equal(count(campaigns, (c) => c.type === 'Open Reward Campaign'), 0);
});

test('default sample: 93 games, 74 publishers, 102 unique ids', () => {
	const { campaigns } = extractSample('page_source_default.html');
	assert.equal(new Set(campaigns.map((c) => c.gameKey)).size, 93);
	assert.equal(new Set(campaigns.map((c) => c.publisherKey)).size, 74);
	assert.equal(new Set(campaigns.map((c) => c.id)).size, 102);
});

test('default sample: first campaign is ARC Raiders with local dates', () => {
	const [first] = extractSample('page_source_default.html').campaigns;
	assert.equal(first.type, 'Open Drop Campaign');
	assert.equal(first.game, 'ARC Raiders');
	assert.equal(first.publisher, 'Embark Studios');
	assert.equal(first.start, local(2026, 10, 8, 4, 0));
	assert.equal(first.end, local(2026, 11, 4, 5, 44));
	assert.equal(first.status, 'active');
});

test('default sample: every Closed campaign has ended and counts as closed', () => {
	const { campaigns, now } = extractSample('page_source_default.html');
	const closed = campaigns.filter((c) => c.type === 'Closed Drop Campaign');
	assert.equal(closed.length, 18);
	for (const campaign of closed) {
		assert.ok(campaign.end < now, `${campaign.game} ended`);
		assert.equal(campaign.closed, true);
		assert.equal(campaign.status, 'ended');
	}
	assert.equal(count(campaigns, (c) => c.closed), 18, 'no Open campaign had ended at capture time');
});

test('default sample: Overwatch has an Open and a Closed campaign with one gameKey', () => {
	const overwatch = byGame(extractSample('page_source_default.html').campaigns, 'Overwatch');
	assert.equal(overwatch.length, 2);
	assert.deepEqual(overwatch.map((c) => c.type).sort(), ['Closed Drop Campaign', 'Open Drop Campaign']);
	assert.notEqual(overwatch[0].id, overwatch[1].id);
	assert.equal(overwatch[0].gameKey, overwatch[1].gameKey);
});

test('default sample: no bodies loaded, so no rewards are known', () => {
	const { campaigns } = extractSample('page_source_default.html');
	assert.equal(count(campaigns, (c) => c.rewards !== null), 0);
	assert.equal(count(campaigns, (c) => c.bodyLoaded), 0);
	assert.equal(count(campaigns, (c) => c.expanded), 0);
});

test('expanded, collapsed and stitched samples produce the same ids as the default', () => {
	const expected = ids(extractSample('page_source_default.html'));
	for (const name of ['page_source_opencampaigns.html', 'page_source_single_expanded.html', 'page_source_expand_then_collapse.html']) {
		assert.deepEqual(ids(extractSample(name)), expected, name);
	}
});

test('single_expanded: only ARC Raiders is expanded', () => {
	const expanded = extractSample('page_source_single_expanded.html').campaigns.filter((c) => c.expanded);
	assert.deepEqual(expanded.map((c) => c.game), ['ARC Raiders']);
	assert.deepEqual(expanded[0].rewards.map((r) => r.name), ['Mailbox', 'Oxygen Respirator']);
});

test('expand_then_collapse: ARC Raiders is collapsed but its rewards still extract', () => {
	const [arc] = byGame(extractSample('page_source_expand_then_collapse.html').campaigns, 'ARC Raiders');
	assert.equal(arc.expanded, false);
	assert.equal(arc.bodyLoaded, true);
	assert.deepEqual(arc.rewards.map((r) => r.name), ['Mailbox', 'Oxygen Respirator']);
});

test('opencampaigns: 470 rewards, 460 In-Game Item and 10 Badge, all readable', () => {
	const { campaigns } = extractSample('page_source_opencampaigns.html');
	assert.equal(count(campaigns, (c) => c.rewards === null), 0);
	const rewards = campaigns.flatMap((c) => c.rewards);
	assert.equal(rewards.length, 470);
	assert.equal(count(rewards, (r) => r.type === 'In-Game Item'), 460);
	assert.equal(count(rewards, (r) => r.type === 'Badge'), 10);
	assert.ok(rewards.every((r) => r.name), 'every reward has a name');
	// Badge art uses /badges/v1/{uuid}/; only the two Palia placeholders (REWARD/default.png) have no uuid.
	assert.deepEqual(rewards.filter((r) => !r.imageUuid).map((r) => r.name).sort(), ['10x Akwinduu Chapaa', '10x Meaty Stir Fry']);
	assert.equal(rewards.find((r) => r.name === 'QSMP2').imageUuid, '2fa68fb9-fcdd-4795-bfab-f408e10efaef');
	assert.equal(new Set(rewards.map((r) => r.key)).size, 470, 'reward keys are unique');
});

test('opencampaigns: Enshrouded title, rewards and connected account', () => {
	const [enshrouded] = byGame(extractSample('page_source_opencampaigns.html').campaigns, 'Enshrouded');
	assert.equal(enshrouded.title, 'Enshrouded Artificer');
	assert.equal(enshrouded.rewards.length, 6);
	assert.equal(enshrouded.connection, 'connected');
	assert.deepEqual(enshrouded.redeem, ['watch']);
});

test('opencampaigns: ARC Raiders needs an account connection', () => {
	const [arc] = byGame(extractSample('page_source_opencampaigns.html').campaigns, 'ARC Raiders');
	assert.equal(arc.connection, 'required');
	assert.equal(arc.title, 'Frozen Trail');
});

test('opencampaigns: closed watermark on all 64 Closed tiles and on no Open tile', () => {
	const { campaigns } = extractSample('page_source_opencampaigns.html');
	const tiles = (list) => list.flatMap((c) => c.rewards);
	const closedTiles = tiles(campaigns.filter((c) => c.type === 'Closed Drop Campaign'));
	const openTiles = tiles(campaigns.filter((c) => c.type !== 'Closed Drop Campaign'));
	assert.equal(closedTiles.length, 64);
	assert.ok(closedTiles.every((r) => r.closedMark));
	assert.ok(openTiles.every((r) => !r.closedMark));
});

test('opencampaigns: summary matches the sample facts', () => {
	const summary = tres.summarize(extractSample('page_source_opencampaigns.html'));
	assert.equal(summary.headers, 102);
	assert.equal(summary.parsed, 102);
	assert.equal(summary.rewardsKnown, 102);
	assert.equal(summary.watermarks, 64);
	assert.deepEqual(summary.tilesByType, { 'In-Game Item': 460, Badge: 10 });
});

test('fixture: moving ARC Raiders under the Closed heading changes its type but not its id', () => {
	const { document, now } = loadSample('page_source_default.html');
	const before = tres.extractCampaigns(document, now).campaigns.find((c) => c.game === 'ARC Raiders');
	const arcRoot = headerOf(document, 'ARC Raiders').parentElement;
	const closedRoot = headerOf(document, 'Overwatch', /Oct 6/).parentElement;
	closedRoot.parentElement.insertBefore(arcRoot, closedRoot);
	const after = tres.extractCampaigns(document, now).campaigns.find((c) => c.game === 'ARC Raiders');
	assert.equal(before.type, 'Open Drop Campaign');
	assert.equal(after.type, 'Closed Drop Campaign');
	assert.equal(after.id, before.id);
});

test('fixture: a reward tile without a type pill makes that campaign\'s rewards unknown', () => {
	const { document, now } = loadSample('page_source_opencampaigns.html');
	headerOf(document, 'ARC Raiders').nextElementSibling.querySelector('.drop-benefit__image-container').parentElement.querySelector('span.tw-pill').remove();
	const result = tres.extractCampaigns(document, now);
	const arc = result.campaigns.find((c) => c.game === 'ARC Raiders');
	assert.equal(arc.rewards, null);
	assert.equal(arc.rewardsUnreadable, true);
	assert.equal(tres.summarize(result).unreadable, 1);
});

test('fixture: non-English headings leave the page unrecognised', () => {
	const { document, now } = loadSample('page_source_default.html');
	for (const heading of document.querySelectorAll('h4')) heading.textContent = 'Kampagnen';
	const result = tres.extractCampaigns(document, now);
	assert.equal(result.found, true);
	assert.equal(result.recognized, false);
	assert.equal(result.campaigns.length, 0);
	assert.equal(result.diagnostics.unknownHeadings.length, 2);
	assert.equal(result.diagnostics.failures.length, 102);
});

test('fixture: a game name with two publishers gives two gameKeys', () => {
	const { document, now } = loadSample('page_source_default.html');
	headerOf(document, 'Overwatch', /Oct 6/).querySelectorAll('p')[1].textContent = 'Blizzard Entertainment';
	const overwatch = byGame(tres.extractCampaigns(document, now).campaigns, 'Overwatch');
	assert.equal(new Set(overwatch.map((c) => c.gameKey)).size, 2);
});

test('no content element means not found, and no throw', () => {
	const { document, now } = loadSample('page_source_default.html');
	document.querySelector('.drops-root__content').remove();
	const result = tres.extractCampaigns(document, now);
	assert.equal(result.found, false);
	assert.equal(result.campaigns.length, 0);
});
