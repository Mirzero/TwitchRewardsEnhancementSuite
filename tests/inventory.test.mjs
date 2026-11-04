import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tres, loadSample, extractSample, headerOf, withScript } from './helpers.mjs';

// Inventory support (spec §11). The four Inventory captures of 2026-11-03 (§11.1):
const FULL = 'page_source_other_tab.html'; // 15:09, full history, no Load More
const FIRST_PAGE = 'page_source_inventory_default.html'; // 18:44, 20 claims + Load More
const JUST_CLAIMED = 'page_source_inventory_just_claimed.html'; // 20:34, Cyberpunk claimed "32 minutes ago"
const CLAIMABLE = 'page_source_inventory_claimable.html'; // 21:25, two THE FINALS rewards show Claim Now
const INVENTORY_URL = 'https://www.twitch.tv/drops/inventory';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function readInventory(name) {
	const { document, now } = loadSample(name, INVENTORY_URL);
	return { ...tres.extractInventory(document, now), now };
}

const campaigns = () => extractSample('page_source_opencampaigns.html').campaigns;
const nameOfKey = (list) => new Map(list.flatMap((c) => c.rewards.map((r) => [r.key, `${c.game}: ${r.name}`])));
const group = (snapshot, title) => snapshot.inProgress.find((g) => g.title === title);

// ---------------------------------------------------------------------------
// Extraction (§11.1)
// ---------------------------------------------------------------------------

test('full history: 2 drop groups with percentages and image ids, 42 claims, no Load More', () => {
	const { snapshot, loadMore, ready, diagnostics } = readInventory(FULL);
	assert.equal(ready, true);
	assert.equal(loadMore, null);
	assert.equal(snapshot.complete, true);
	assert.deepEqual(snapshot.inProgress.map((g) => g.title), ['PRIME TIME', 'Season 10.5 Twitch Drops']);
	const prime = group(snapshot, 'PRIME TIME');
	assert.equal(prime.dropId, 'aefa907c-43d5-4187-beed-4576c246ef7b');
	assert.equal(prime.endText, 'Thu, Nov 5, 2:29 AM PDT');
	assert.deepEqual(prime.rewards.map((r) => [r.name, r.percent, r.requiredText, r.state]), [
		['Bebe the Barricade', 7, '4 hours', 'progress'],
		['Meet Bebe Sticker', 31, '1 hour', 'progress'],
		['Pocket Bebe Charm', 15, '2 hours', 'progress']
	]);
	assert.ok(prime.rewards.every((r) => /^[0-9a-f-]{36}$/.test(r.imageUuid)));
	assert.equal(snapshot.claims.length, 42);
	assert.deepEqual(snapshot.claims[0], {
		name: 'Animated Ancient Globe', imageUuid: 'c27018ae-dc6b-46c4-bd8e-e55ebff074a7', timeText: '1 hour ago',
		earliest: snapshot.readAt - 2 * HOUR, latest: snapshot.readAt - HOUR
	});
	assert.deepEqual(diagnostics.unknownTimes, []);
});

test('first page: 20 claims and a Load More button; a 100% reward without a connected account is "connect"', () => {
	const { snapshot, loadMore, diagnostics } = readInventory(FIRST_PAGE);
	assert.equal(loadMore.textContent, 'Load More');
	assert.equal(snapshot.complete, false);
	assert.equal(snapshot.claims.length, 20);
	assert.deepEqual(diagnostics, { groups: 3, rewards: 11, claims: 20, unknownTimes: [] });
	assert.deepEqual(group(snapshot, 'PRIME TIME').rewards.map((r) => r.state), ['progress', 'connect', 'progress']);
	assert.deepEqual(group(snapshot, 'Quadra Paintjobs').rewards.map((r) => r.name), ['Short-Fuse Neon', 'Tactical Warning', 'Road Scar', 'Dazzling Encore']);
});

test('claimable: Claim Now rewards keep their name and read 100%', () => {
	const { snapshot } = readInventory(CLAIMABLE);
	assert.deepEqual(group(snapshot, 'PRIME TIME').rewards.map((r) => [r.name, r.percent, r.state]), [
		['Bebe the Barricade', 54, 'progress'],
		['Meet Bebe Sticker', 100, 'claimable'],
		['Pocket Bebe Charm', 100, 'claimable']
	]);
});

test('just claimed: the claims read "32 minutes ago" and their group has left In Progress', () => {
	const { snapshot } = readInventory(JUST_CLAIMED);
	assert.equal(group(snapshot, 'Quadra Paintjobs'), undefined);
	const roadScar = snapshot.claims.find((c) => c.name === 'Road Scar');
	assert.equal(roadScar.timeText, '32 minutes ago');
	assert.deepEqual([roadScar.earliest, roadScar.latest], [snapshot.readAt - 33 * MINUTE, snapshot.readAt - 32 * MINUTE]);
});

test('the Campaigns page stays untouched by the Inventory reader: no campaigns found there', () => {
	const { document, now } = loadSample(FULL, INVENTORY_URL);
	assert.equal(tres.extractCampaigns(document, now).campaigns.length, 0);
	assert.equal(tres.extractInventory(loadSample('page_source_default.html').document, now).found, false);
});

// ---------------------------------------------------------------------------
// Relative times (§11.2)
// ---------------------------------------------------------------------------

test('relative times become windows, rounded down', () => {
	const at = Date.UTC(2026, 10, 3, 12);
	const span = (text) => {
		const value = tres.relativeWindow(text, at);
		return value && [(at - value.earliest) / MINUTE, (at - value.latest) / MINUTE];
	};
	assert.deepEqual(span('32 minutes ago'), [33, 32]);
	assert.deepEqual(span('1 hour ago'), [120, 60]);
	assert.deepEqual(span('11 hours ago'), [12 * 60, 11 * 60]);
	assert.deepEqual(span('21 days ago'), [22 * 1440, 21 * 1440]);
	assert.deepEqual(span('last month'), [61 * 1440, 28 * 1440]);
	assert.deepEqual(span('2 months ago'), [3 * 31 * 1440, 28 * 1440]);
	assert.deepEqual(span('6 months ago'), [7 * 31 * 1440, 5 * 28 * 1440]);
	// Not seen, accepted defensively.
	assert.deepEqual(span('just now'), [1, 0]);
	assert.deepEqual(span('45 seconds ago'), [1, 0]);
	assert.deepEqual(span('yesterday'), [2 * 1440, 1440]);
	assert.deepEqual(span('an hour ago'), [120, 60]);
	assert.equal(span('last week'), null);
	assert.equal(span('Nov 3'), null);
});

test('the same claims give overlapping windows in all four captures, so rounding down is right', () => {
	const windows = new Map();
	for (const name of [FULL, FIRST_PAGE, JUST_CLAIMED, CLAIMABLE]) {
		for (const claim of readInventory(name).snapshot.claims) {
			if (!/hours? ago|minutes? ago/.test(claim.timeText)) continue;
			const key = `${claim.imageUuid}|${claim.name}`;
			const [earliest, latest] = windows.get(key) || [-Infinity, Infinity];
			windows.set(key, [Math.max(earliest, claim.earliest), Math.min(latest, claim.latest)]);
		}
	}
	assert.equal(windows.size, 10, '6 Enshrouded + 4 Cyberpunk claims');
	for (const [key, [earliest, latest]] of windows) assert.ok(earliest <= latest, `${key} has a consistent window`);
});

// ---------------------------------------------------------------------------
// Matching (§11.3)
// ---------------------------------------------------------------------------

test('In Progress matches by title and image ids despite a different end date and reward count', () => {
	const list = campaigns();
	const names = nameOfKey(list);
	const match = tres.matchInventory(list, readInventory(FIRST_PAGE).snapshot);
	assert.deepEqual(match.matched, { claims: 6, groups: 3, progress: 11 });
	assert.equal(match.unmatched.groups, 0);
	const marvel = list.find((c) => c.title === 'Season 10.5 Twitch Drops');
	assert.equal(new Date(marvel.end).getDate(), 15, 'the card ends Nov 15 while the group ends Nov 6');
	const progress = [...match.progressByKey].map(([key, value]) => [names.get(key), value.percent, value.state]);
	assert.deepEqual(progress.filter(([name]) => name.startsWith('Marvel')), [
		['Marvel Rivals: Angela Emote', 9, 'progress'], ['Marvel Rivals: Angela Costume', 4, 'progress'],
		['Marvel Rivals: Angela Nameplate', 18, 'progress'], ['Marvel Rivals: Angela Spray', 36, 'progress']
	]);
	assert.equal(list.find((c) => c.title === 'Quadra Paintjobs').rewards.length, 5);
	assert.equal(progress.filter(([name]) => name.startsWith('Cyberpunk')).length, 4);
	assert.deepEqual(progress.find(([name]) => name === 'THE FINALS: Meet Bebe Sticker'), ['THE FINALS: Meet Bebe Sticker', 100, 'connect']);
});

test('all 6 Enshrouded claims match, so Enshrouded hides; nothing else is claimed', () => {
	const list = campaigns();
	const names = nameOfKey(list);
	const data = tres.defaultData();
	const match = tres.matchInventory(list, readInventory(FULL).snapshot);
	assert.deepEqual([...match.claimedKeys].map((key) => names.get(key)).sort(), [
		'Enshrouded: Animated Ancient Globe', 'Enshrouded: Artificer Bottom', "Enshrouded: Artificer's Chest",
		"Enshrouded: Artificer's Gloves", "Enshrouded: Artificer's Helmet", 'Enshrouded: Star Map'
	]);
	assert.equal(match.unmatched.ambiguous, 0);
	const claimed = tres.effectiveClaims(data, match);
	const hidden = list.filter((c) => !c.closed && tres.hideReason(c, data.rules, claimed) === 'rewards').map((c) => c.game);
	assert.deepEqual(hidden, ['Enshrouded']);
});

test('the 4 Cyberpunk claims match, and Quadra Paintjobs stays visible because its fifth reward is not claimed', () => {
	const list = campaigns();
	const data = tres.defaultData();
	for (const name of [JUST_CLAIMED, CLAIMABLE]) {
		const match = tres.matchInventory(list, readInventory(name).snapshot);
		assert.equal(match.matched.claims, 10, name);
		const quadra = list.find((c) => c.title === 'Quadra Paintjobs');
		const claimed = tres.effectiveClaims(data, match);
		assert.equal(quadra.rewards.filter((r) => claimed[r.key]).length, 4);
		assert.equal(tres.hideReason(quadra, data.rules, claimed), null);
		assert.equal(tres.campaignProgress(quadra, claimed, match.progressByKey).text, '4/5 claimed');
	}
});

test('a claim whose image two overlapping campaigns share stays unmatched (Gray Zone Warfare)', () => {
	const list = campaigns();
	const madfinger = list.find((c) => c.title === 'Rogue Ops - MADFINGER');
	const stage4 = list.find((c) => c.title === 'Rogue Ops - Stage 4');
	const shared = madfinger.rewards.find((r) => stage4.rewards.filter((s) => s.imageUuid === r.imageUuid).length === 1
		&& madfinger.rewards.filter((s) => s.imageUuid === r.imageUuid).length === 1);
	assert.ok(shared, 'the two campaigns share an image');
	const inside = Math.max(madfinger.start, stage4.start) + HOUR;
	const inventory = { inProgress: [], claims: [{ name: shared.name, imageUuid: shared.imageUuid, timeText: 'x', earliest: inside, latest: inside + HOUR }] };
	const match = tres.matchInventory(list, inventory);
	assert.equal(match.claimedKeys.size, 0);
	assert.equal(match.unmatched.ambiguous, 1);
});

test('recurring campaigns: a claim inside only the first instance marks only that one', () => {
	const daily = (id, start) => ({ id, title: 'Daily Drop', start, end: start + DAY - 1, rewards: [{ key: `${id}|chest`, name: 'Chest', type: 'In-Game Item', imageUuid: 'aaaaaaaa-0000-0000-0000-000000000001' }] });
	const day1 = Date.UTC(2026, 10, 2);
	const list = [daily('d1', day1), daily('d2', day1 + DAY)];
	const claim = (earliest, latest) => ({ inProgress: [], claims: [{ name: 'Chest', imageUuid: 'aaaaaaaa-0000-0000-0000-000000000001', timeText: 'x', earliest, latest }] });
	assert.deepEqual([...tres.matchInventory(list, claim(day1 + 3 * HOUR, day1 + 4 * HOUR)).claimedKeys], ['d1|chest']);
	// A window straddling both days fits neither instance.
	assert.equal(tres.matchInventory(list, claim(day1 + DAY - HOUR, day1 + DAY + HOUR)).claimedKeys.size, 0);
});

test('windowless and coarse claims stay unmatched', () => {
	const list = campaigns();
	const enshrouded = list.find((c) => c.game === 'Enshrouded');
	const uuid = enshrouded.rewards[0].imageUuid;
	const readAt = enshrouded.start + 5 * HOUR;
	const lastMonth = tres.relativeWindow('last month', readAt);
	const match = tres.matchInventory(list, {
		inProgress: [],
		claims: [
			{ name: 'a', imageUuid: uuid, timeText: 'sometime', earliest: null, latest: null },
			{ name: 'b', imageUuid: uuid, timeText: 'last month', ...lastMonth },
			{ name: 'c', imageUuid: null, timeText: '1 hour ago', earliest: readAt - 2 * HOUR, latest: readAt - HOUR }
		]
	});
	assert.equal(match.claimedKeys.size, 0);
	assert.deepEqual(match.unmatched, { claims: 1, ambiguous: 0, noTime: 2, groups: 0 });
});

test('no snapshot means no matches', () => {
	const match = tres.matchInventory(campaigns(), null);
	assert.equal(match.claimedKeys.size, 0);
	assert.equal(match.progressByKey.size, 0);
});

// ---------------------------------------------------------------------------
// Claimed state, overrides and storage (§11.4, §11.6)
// ---------------------------------------------------------------------------

test('an override beats an Inventory claim; manual ticks always count', () => {
	const data = tres.defaultData();
	const match = { claimedKeys: new Set(['a', 'b']) };
	data.inventoryOverrides.b = { at: 1, campaignId: 'x' };
	data.claimed.c = { name: 'C', campaignId: 'x', claimedAt: 1 };
	assert.deepEqual(tres.effectiveClaims(data, match), { c: data.claimed.c, a: { source: 'inventory' } });
});

test('campaign progress pill text and tooltip', () => {
	const campaign = { rewards: [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }, { key: 'c', name: 'C' }, { key: 'd', name: 'D' }] };
	const progress = new Map([['b', { percent: 36, requiredText: '30 minutes', state: 'progress' }], ['c', { percent: 100, requiredText: '1 hour', state: 'claimable' }]]);
	const result = tres.campaignProgress(campaign, { a: { source: 'inventory' } }, progress);
	assert.equal(result.text, '1/4 claimed · 100%');
	assert.equal(result.title, 'A: claimed (Inventory)\nB: 36% of 30 minutes\nC: Ready to claim\nD: no progress');
	assert.equal(tres.campaignProgress(campaign, {}, new Map()), null);
	assert.equal(tres.progressLabel({ percent: 100, state: 'connect' }), '100% · connect account');
});

test('a stored snapshot survives sanitizing; garbage becomes null', () => {
	const { snapshot } = readInventory(FIRST_PAGE);
	assert.deepEqual(tres.sanitizeInventory(JSON.parse(JSON.stringify(snapshot))), snapshot);
	assert.deepEqual(tres.sanitizeInventory(JSON.stringify(snapshot)), snapshot);
	for (const bad of [null, 'not json', {}, { schema: 99, readAt: 1, inProgress: [], claims: [] }, { schema: 1, readAt: 'x', inProgress: [], claims: [] }]) {
		assert.equal(tres.sanitizeInventory(bad), null);
	}
});

test('overrides: kept by sanitize, unioned on import, pruned with their campaign', () => {
	const data = tres.defaultData();
	data.inventoryOverrides.k1 = { at: 1, campaignId: 'old' };
	data.campaigns.old = { firstSeen: 0, lastSeen: 0, end: 1 };
	assert.deepEqual(tres.sanitizeData(data).inventoryOverrides, data.inventoryOverrides);
	const imported = tres.defaultData();
	imported.inventoryOverrides.k2 = { at: 2, campaignId: 'new' };
	assert.deepEqual(Object.keys(tres.mergeImport(data, imported).inventoryOverrides).sort(), ['k1', 'k2']);
	tres.prune(data, 100 * DAY);
	assert.deepEqual(data.inventoryOverrides, {});
});

// ---------------------------------------------------------------------------
// The live script (§11.2, §11.5)
// ---------------------------------------------------------------------------

const panelPill = (document) => document.querySelector('#tres-panel .tres-pill');
const tileOf = (root, name) => [...root.querySelectorAll('.drop-benefit__image-container')].map((c) => c.parentElement).find((t) => t.querySelector('p').textContent === name);

test('on the Inventory page: the Inventory panel appears, the page is read and the snapshot saved', async () => {
	const storage = tres.memoryStorage();
	await withScript(FULL, ({ document }) => {
		assert.equal(document.querySelectorAll('#tres-panel').length, 1);
		assert.equal(document.querySelector('#tres-panel').dataset.page, 'inventory');
		assert.equal(panelPill(document).textContent, 'TRES · 42 claimed · 7 in progress');
		const sections = [...document.querySelectorAll('#tres-panel details')].map((d) => [d.querySelector('summary').textContent, d.open]);
		assert.deepEqual(sections, [['Inventory', false], ['Diagnostics', false]]);
		assert.equal(document.querySelectorAll('.drops-root__content [data-tres]').length, 0, 'nothing injected into the Inventory page');
		const stored = storage.readInventory();
		assert.equal(stored.claims.length, 42);
		assert.equal(stored.complete, true);
		assert.equal(storage.read(), null, 'the settings are never written from the Inventory page');
	}, { url: INVENTORY_URL, storage });
});

test('on the Campaigns page: Inventory claims hide Enshrouded, and progress shows on tiles and headers', async () => {
	const storage = tres.memoryStorage(null, readInventory(FULL).snapshot);
	await withScript('page_source_opencampaigns.html', ({ document, app }) => {
		const enshrouded = headerOf(document, 'Enshrouded').parentElement;
		assert.ok(enshrouded.classList.contains('tres-hidden'));
		assert.equal(app.state.reasons.get(app.state.result.campaigns.find((c) => c.game === 'Enshrouded').id), 'rewards');
		const star = tileOf(enshrouded, 'Star Map');
		assert.equal(star.querySelector('.tres-claim input').checked, true);
		assert.equal(star.querySelector('.tres-done-reason').textContent, 'claimed (Inventory)');
		assert.equal(headerOf(document, 'Enshrouded').querySelector('.tres-header-progress').textContent, '6/6 claimed');

		const marvelHeader = [...document.querySelectorAll('.accordion-header')].find((h) => h.parentElement.textContent.includes('Season 10.5 Twitch Drops'));
		const progressPill = marvelHeader.querySelector('.tres-header-progress');
		assert.equal(progressPill.textContent, '0/9 claimed · 36%');
		assert.match(progressPill.title, /Angela Spray: 36% of 30 minutes/);
		const spray = tileOf(marvelHeader.parentElement, 'Angela Spray');
		assert.equal(spray.querySelector('.tres-progress-pill').textContent, '36% of 30 minutes');
		assert.equal(spray.querySelector('.tres-progress > div').style.width, '36%');
		assert.ok(spray.querySelector('.drop-benefit__image-container').hasAttribute('data-tres-in-progress'));
		assert.equal(document.querySelectorAll('.tres-progress-pill').length, 7, 'THE FINALS and Marvel Rivals rewards');

		const inventorySection = [...document.querySelectorAll('#tres-panel details')].find((d) => d.querySelector('summary').textContent === 'Inventory');
		assert.match(inventorySection.textContent, /Inventory last read just now · complete history\./);
		assert.match(inventorySection.textContent, /6 claims matched · 7 rewards in progress · 36 claims unmatched \(0 ambiguous\) · 0 In Progress groups unmatched\./);
	}, { storage });
});

test('unticking an Inventory claim records an override; ticking it again removes it', async () => {
	const storage = tres.memoryStorage(null, readInventory(FULL).snapshot);
	await withScript('page_source_opencampaigns.html', ({ window, document, app }) => {
		const root = headerOf(document, 'Enshrouded').parentElement;
		const input = () => tileOf(root, 'Star Map').querySelector('.tres-claim input');
		input().checked = false;
		input().dispatchEvent(new window.Event('change', { bubbles: true }));
		const key = input().dataset.rewardKey;
		assert.deepEqual(Object.keys(app.state.data.inventoryOverrides), [key]);
		assert.equal(input().checked, false);
		assert.ok(!root.classList.contains('tres-hidden'), 'no longer every reward claimed');
		assert.equal(headerOf(document, 'Enshrouded').querySelector('.tres-header-progress').textContent, '5/6 claimed');

		input().checked = true;
		input().dispatchEvent(new window.Event('change', { bubbles: true }));
		assert.deepEqual(app.state.data.inventoryOverrides, {});
		assert.deepEqual(app.state.data.claimed, {}, 'the Inventory claim is enough; no manual mark');
		assert.ok(root.classList.contains('tres-hidden'));
	}, { storage });
});

test('Clear Inventory claims drops Inventory marks and progress but keeps manual ticks', async () => {
	const storage = tres.memoryStorage(null, readInventory(FULL).snapshot);
	await withScript('page_source_opencampaigns.html', ({ window, document, app }) => {
		const arc = headerOf(document, 'ARC Raiders').parentElement;
		const tile = arc.querySelector('.tres-claim input');
		tile.checked = true;
		tile.dispatchEvent(new window.Event('change', { bubbles: true }));
		window.confirm = () => true;
		assert.equal(app.actions.clearInventory(), 'Inventory claims cleared.');
		assert.equal(storage.readInventory(), null);
		assert.ok(!headerOf(document, 'Enshrouded').parentElement.classList.contains('tres-hidden'));
		assert.equal(document.querySelectorAll('.tres-progress-pill, .tres-progress').length, 0);
		assert.equal(Object.keys(app.state.data.claimed).length, 1);
		assert.match(document.querySelector('#tres-panel').textContent, /Not read yet\. Open the Inventory tab once\./);
	}, { storage });
});

test('live sync: a snapshot saved by another tab applies at once', async () => {
	const storage = tres.memoryStorage();
	await withScript('page_source_opencampaigns.html', ({ document }) => {
		const root = headerOf(document, 'Enshrouded').parentElement;
		assert.ok(!root.classList.contains('tres-hidden'));
		storage.writeInventory(readInventory(FULL).snapshot);
		assert.ok(root.classList.contains('tres-hidden'));
	}, { storage });
});

test('Reset all clears overrides but keeps the snapshot; import takes a newer snapshot only', async () => {
	const older = readInventory(FULL).snapshot;
	const newer = readInventory(FIRST_PAGE).snapshot;
	const storage = tres.memoryStorage(null, older);
	await withScript('page_source_opencampaigns.html', async ({ window, app }) => {
		window.confirm = () => true;
		app.state.data.inventoryOverrides.x = { at: 1, campaignId: 'y' };
		app.actions.resetAll();
		assert.deepEqual(app.state.data.inventoryOverrides, {});
		assert.equal(storage.readInventory().readAt, older.readAt);

		const file = (inventory) => ({ text: async () => JSON.stringify({ ...tres.defaultData(), inventory }) });
		assert.equal(await app.actions.importFile(file(newer)), 'Imported and merged.');
		assert.equal(storage.readInventory().readAt, newer.readAt);
		await app.actions.importFile(file(older));
		assert.equal(storage.readInventory().readAt, newer.readAt, 'an older snapshot never replaces a newer one');
	}, { storage });
});

/** Makes Load More add 3 more claims per click, and disappear after `pages` clicks. */
function stubLoadMore(pages) {
	return (document, window) => {
		const images = document.querySelectorAll('img.inventory-drop-image[alt^="Drop image for"]');
		let entry = images[0];
		while (!entry.parentElement.contains(images[1])) entry = entry.parentElement;
		const list = entry.parentElement;
		const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Load More');
		let clicks = 0;
		button.addEventListener('click', () => window.setTimeout(() => {
			clicks += 1;
			for (const node of [...list.children].slice(0, 3)) list.append(node.cloneNode(true));
			if (clicks >= pages) button.remove();
		}, 5));
	};
}

test('Scan full history clicks Load More until it is gone, then saves a complete snapshot', async () => {
	const storage = tres.memoryStorage();
	await withScript(FIRST_PAGE, async ({ document, inventory }) => {
		assert.equal(storage.readInventory().complete, false);
		assert.equal(storage.readInventory().claims.length, 20);
		await inventory.actions.scanHistory();
		assert.equal(inventory.state.history.clicks, 2);
		assert.equal(inventory.state.history.timedOut, false);
		assert.equal(storage.readInventory().complete, true);
		assert.equal(storage.readInventory().claims.length, 26);
		assert.match(document.querySelector('#tres-panel').textContent, /Finished: the full history is read\./);
	}, { url: INVENTORY_URL, storage, prepare: stubLoadMore(2), loaderPollMs: 5 });
});

test('Scan full history can be cancelled', async () => {
	const storage = tres.memoryStorage();
	await withScript(FIRST_PAGE, async ({ inventory }) => {
		const running = inventory.actions.scanHistory();
		assert.equal(inventory.state.history.running, true);
		inventory.actions.cancelScan();
		await running;
		assert.equal(inventory.state.history.clicks, 1);
		assert.equal(inventory.state.history.cancelled, true);
		assert.equal(storage.readInventory().complete, false);
	}, { url: INVENTORY_URL, storage, prepare: stubLoadMore(5), loaderPollMs: 5 });
});

test('Clear and rescan reads the page again', async () => {
	const storage = tres.memoryStorage();
	await withScript(FULL, ({ inventory }) => {
		assert.equal(inventory.actions.clearAndRescan(), 'Cleared and read again.');
		assert.equal(storage.readInventory().claims.length, 42);
	}, { url: INVENTORY_URL, storage });
});

test('Rescan on Inventory tab follows Twitch\'s own Inventory link', async () => {
	await withScript('page_source_default.html', ({ window, document, app }) => {
		const link = document.createElement('a');
		link.href = '/drops/inventory';
		let clicked = 0;
		link.addEventListener('click', (event) => { event.preventDefault(); clicked += 1; });
		document.body.append(link);
		app.actions.openInventory();
		assert.equal(clicked, 1);
	});
});
