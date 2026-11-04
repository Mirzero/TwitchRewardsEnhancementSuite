import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tres, loadSample, headerOf } from './helpers.mjs';

const wait = (window, ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Starts the script on a sample at the sample's capture time (so results don't drift as
 * campaigns end in real life) and always stops it, so timers don't keep Node alive.
 */
async function withScript(name, run, { url, storage = tres.memoryStorage(), prepare, loaderPollMs } = {}) {
	const { window, document, now } = loadSample(name, url);
	if (prepare) prepare(document);
	const handle = tres.start(window, storage, { now: () => now, loaderPollMs });
	try {
		return await run({ window, document, handle, app: handle.app, storage });
	} finally {
		handle.stop();
	}
}

const click = (window, target, type = 'click') => target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true }));
const roots = (document) => [...document.querySelectorAll('.accordion-header[role="heading"][aria-level="3"]')].map((h) => h.parentElement);
const hiddenGames = (document) => roots(document).filter((r) => r.classList.contains('tres-hidden')).map((r) => r.querySelector('p').textContent);
const menuItems = (document) => [...document.querySelectorAll('#tres-menu button')];
const panelInput = (document, text) => [...document.querySelectorAll('#tres-panel label')].find((l) => l.textContent.startsWith(text)).querySelector('input');

test('defaults: exactly the 18 Closed campaigns are hidden', async () => {
	await withScript('page_source_default.html', ({ document, app }) => {
		const hidden = roots(document).filter((r) => r.classList.contains('tres-hidden'));
		assert.equal(hidden.length, 18);
		assert.equal(document.querySelector('#tres-panel .tres-pill').textContent, 'TRES · 18 hidden');
		assert.equal(document.querySelector('#tres-panel .tres-summary').textContent, '84 shown · 18 hidden · 102 campaigns (18 closed)');
		assert.equal(panelInput(document, 'Show hidden').parentElement.querySelector('.tres-count').textContent, '18');
		assert.equal(app.state.result.campaigns.length, 102);
	});
});

test('the Closed section gets an "18 hidden" note under its heading', async () => {
	await withScript('page_source_default.html', ({ document }) => {
		const notes = [...document.querySelectorAll('.tres-section-note')];
		assert.equal(notes.length, 1);
		assert.equal(notes[0].textContent, '18 hidden');
		assert.equal(notes[0].previousElementSibling.textContent, 'Closed Drop Campaigns');
	});
});

test('one Hide button per header, and rescanning never duplicates them', async () => {
	await withScript('page_source_default.html', ({ document, app }) => {
		assert.equal(document.querySelectorAll('.tres-hide-btn').length, 102);
		app.state.dirty = new Set(roots(document));
		app.scanNow();
		app.scanNow();
		assert.equal(document.querySelectorAll('.tres-hide-btn').length, 102);
		for (const header of document.querySelectorAll('.accordion-header')) {
			assert.equal(header.querySelectorAll(':scope > .tres-controls').length, 1);
		}
	});
});

test('clicking Hide opens the menu without toggling the campaign', async () => {
	await withScript('page_source_default.html', ({ window, document }) => {
		const header = headerOf(document, 'ARC Raiders');
		let twitchSawClick = false;
		header.querySelector('button').addEventListener('click', () => { twitchSawClick = true; });
		document.body.addEventListener('click', () => { twitchSawClick = true; });
		click(window, header.querySelector('.tres-hide-btn'));
		assert.equal(header.querySelector('button').getAttribute('aria-expanded'), 'false');
		assert.equal(twitchSawClick, false, 'the click never reaches the page');
		assert.deepEqual(menuItems(document).map((b) => b.textContent), ['Hide this campaign', 'Hide all ARC Raiders', 'Hide all from Embark Studios']);
	});
});

test('Hide all {Game} hides that game in every section, and survives a restart', async () => {
	const storage = tres.memoryStorage();
	await withScript('page_source_default.html', async ({ window, document, app }) => {
		panelInput(document, 'Hide closed').click();
		click(window, headerOf(document, 'Overwatch', /Oct 30/).querySelector('.tres-hide-btn'));
		menuItems(document).find((b) => b.textContent === 'Hide all Overwatch').click();
		assert.deepEqual(hiddenGames(document), ['Overwatch', 'Overwatch']);
		app.flushWrite();
	}, { storage });
	assert.ok(storage.read().rules.hiddenGames['overwatch|blizzard']);
	await withScript('page_source_default.html', ({ document }) => {
		assert.deepEqual(hiddenGames(document), ['Overwatch', 'Overwatch'], 'still hidden after reload');
		click(document.defaultView, headerOf(document, 'Overwatch', /Oct 30/).querySelector('.tres-hide-btn'));
		assert.ok(menuItems(document).some((b) => b.textContent === 'Unhide all Overwatch'));
	}, { storage });
});

test('Hide this campaign hides exactly one, and the Hidden list can unhide it', async () => {
	await withScript('page_source_default.html', ({ window, document }) => {
		click(window, headerOf(document, 'ARC Raiders').querySelector('.tres-hide-btn'));
		menuItems(document)[0].click();
		assert.ok(headerOf(document, 'ARC Raiders').parentElement.classList.contains('tres-hidden'));
		assert.equal(roots(document).filter((r) => r.classList.contains('tres-hidden')).length, 19);
		const unhide = document.querySelector('#tres-panel .tres-hidden-list button');
		assert.match(unhide.previousElementSibling.textContent, /^ARC Raiders — Embark Studios/);
		unhide.click();
		assert.ok(!headerOf(document, 'ARC Raiders').parentElement.classList.contains('tres-hidden'));
	});
});

test('panel toggles: Hide closed off shows them; Show hidden dims instead of hiding, with reasons', async () => {
	await withScript('page_source_default.html', ({ document }) => {
		panelInput(document, 'Hide closed').click();
		assert.equal(document.querySelectorAll('.tres-hidden').length, 0);
		panelInput(document, 'Hide closed').click();
		panelInput(document, 'Show hidden').click();
		assert.equal(document.querySelectorAll('.tres-hidden').length, 0);
		assert.equal(document.querySelectorAll('.tres-dimmed').length, 18);
		const reasons = [...document.querySelectorAll('.tres-reason')].filter((r) => !r.hidden).map((r) => r.textContent);
		assert.equal(reasons.length, 18);
		assert.ok(reasons.every((text) => text === 'hidden: closed'));
		assert.equal(document.querySelectorAll('.tres-section-note').length, 0, 'no "all hidden" note while showing hidden');
	});
});

test('publisher list: toggling in the Open group hides the publisher everywhere', async () => {
	await withScript('page_source_default.html', ({ document }) => {
		panelInput(document, 'Hide closed').click();
		const openGroup = [...document.querySelectorAll('#tres-panel details')].find((d) => d.querySelector('summary').textContent.startsWith('Open'));
		openGroup.querySelector('.tres-options input[value="blizzard"]').click();
		const blizzard = roots(document).filter((r) => r.querySelectorAll('p')[1].textContent === 'Blizzard');
		assert.ok(blizzard.length >= 2);
		assert.ok(blizzard.every((r) => r.classList.contains('tres-hidden')));
		const closedGroup = [...document.querySelectorAll('#tres-panel details')].find((d) => d.querySelector('summary').textContent.startsWith('Closed'));
		assert.equal(closedGroup.querySelector('.tres-options input[value="blizzard"]').checked, true, 'both groups show the same state');
	});
});

test('reward tiles: Claimed checkboxes, and claiming every reward hides the campaign', async () => {
	await withScript('page_source_opencampaigns.html', ({ document }) => {
		const header = headerOf(document, 'Enshrouded');
		const boxes = [...header.nextElementSibling.querySelectorAll('.tres-claim input')];
		assert.equal(boxes.length, 6);
		for (const box of boxes.slice(0, 5)) box.click();
		assert.ok(!header.parentElement.classList.contains('tres-hidden'));
		assert.equal(header.nextElementSibling.querySelectorAll('[data-tres-done]').length, 5);
		boxes[5].click();
		assert.ok(header.parentElement.classList.contains('tres-hidden'));
	});
});

test('reward types: hiding Badge hides badge-only campaigns and labels badge tiles', async () => {
	await withScript('page_source_opencampaigns.html', ({ document }) => {
		const badge = document.querySelector('#tres-panel .tres-options input[value="badge"]');
		badge.click();
		const hidden = hiddenGames(document).filter((game) => ['QSMP', 'Dead by Daylight', 'ELDEN RING', 'League of Legends'].includes(game));
		assert.deepEqual(hidden.sort(), ['Dead by Daylight', 'ELDEN RING', 'QSMP']);
		const lol = headerOf(document, 'League of Legends').nextElementSibling;
		const labels = [...lol.querySelectorAll('.tres-done-reason')].filter((n) => !n.hidden).map((n) => n.textContent);
		assert.deepEqual(labels, ['hidden type: Badge', 'hidden type: Badge']);
	});
});

test('rewards learned in one visit hide a collapsed campaign in the next', async () => {
	const storage = tres.memoryStorage();
	await withScript('page_source_opencampaigns.html', ({ document, app }) => {
		for (const box of headerOf(document, 'Enshrouded').nextElementSibling.querySelectorAll('.tres-claim input')) box.click();
		app.flushWrite();
	}, { storage });
	await withScript('page_source_default.html', ({ document }) => {
		assert.ok(headerOf(document, 'Enshrouded').parentElement.classList.contains('tres-hidden'));
		assert.match(document.querySelector('#tres-panel .tres-note').textContent, /^Rewards known for 102 \/ 102/);
	}, { storage });
});

test('no loop: applying rules and injecting controls never triggers another scan', async () => {
	await withScript('page_source_default.html', async ({ window, document, app }) => {
		await wait(window, 250);
		const scans = app.state.scanCount;
		click(window, headerOf(document, 'ARC Raiders').querySelector('.tres-hide-btn'));
		menuItems(document)[0].click();
		panelInput(document, 'Show hidden').click();
		await wait(window, 250);
		assert.equal(app.state.scanCount, scans);
	});
});

test('mutations: opening a campaign re-parses only that campaign', async () => {
	await withScript('page_source_default.html', async ({ window, document, app }) => {
		const before = app.state.result.campaigns.find((c) => c.game === 'Enshrouded');
		const untouched = app.state.result.campaigns.find((c) => c.game === 'ARC Raiders');
		headerOf(document, 'Enshrouded').querySelector('button').setAttribute('aria-expanded', 'true');
		await wait(window, 250);
		const result = app.state.result;
		const after = result.campaigns.find((c) => c.game === 'Enshrouded');
		assert.equal(after.expanded, true);
		assert.equal(after.id, before.id);
		assert.notEqual(after, before, 'the changed campaign was re-parsed');
		assert.equal(result.campaigns.find((c) => c.game === 'ARC Raiders'), untouched, 'others were reused from the cache');
	});
});

test('panel: starts collapsed, pill expands, outside click and Esc collapse', async () => {
	await withScript('page_source_default.html', ({ window, document }) => {
		const panel = document.querySelector('#tres-panel');
		assert.equal(panel.dataset.expanded, 'false');
		click(window, panel.querySelector('.tres-pill'));
		assert.equal(panel.dataset.expanded, 'true');
		click(window, panel.querySelector('.tres-summary'), 'mousedown');
		assert.equal(panel.dataset.expanded, 'true', 'a click inside keeps it open');
		click(window, document.querySelector('.drops-root__content'), 'mousedown');
		assert.equal(panel.dataset.expanded, 'false');
		click(window, panel.querySelector('.tres-pill'));
		document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.equal(panel.dataset.expanded, 'false');
	});
});

test('panel: does not collapse while typing in a search box', async () => {
	await withScript('page_source_default.html', ({ window, document }) => {
		const panel = document.querySelector('#tres-panel');
		click(window, panel.querySelector('.tres-pill'));
		const search = panel.querySelector('input[type="search"]');
		search.focus();
		click(window, document.querySelector('.drops-root__content'), 'mousedown');
		assert.equal(panel.dataset.expanded, 'true');
	});
});

test('diagnostics: header and parse counts are shown', async () => {
	await withScript('page_source_default.html', ({ document }) => {
		const lines = [...document.querySelectorAll('#tres-panel .tres-diag li')].map((li) => li.textContent);
		assert.ok(lines.includes('Headers found: 102 · campaigns parsed: 102'), lines.join('\n'));
		assert.ok(document.querySelector('#tres-panel .tres-warning').hidden);
	});
});

test('unrecognised page: English warning, nothing hidden, nothing injected', async () => {
	await withScript('page_source_default.html', ({ document }) => {
		assert.equal(document.querySelector('#tres-panel .tres-warning').hidden, false);
		assert.equal(document.querySelector('#tres-panel .tres-pill').textContent, 'TRES · !');
		assert.equal(document.querySelectorAll('.tres-hidden, .tres-dimmed').length, 0);
		assert.equal(document.querySelectorAll('.drops-root__content [data-tres]').length, 0);
	}, { prepare: (document) => { for (const heading of document.querySelectorAll('h4')) heading.textContent = 'Kampagnen'; } });
});

test('the script stays inactive on the Inventory page and starts after navigating to campaigns', async () => {
	await withScript('page_source_default.html', ({ window, document }) => {
		assert.equal(document.querySelector('#tres-panel'), null);
		window.history.pushState({}, '', '/drops/campaigns');
		assert.equal(document.querySelectorAll('#tres-panel').length, 1);
		window.history.pushState({}, '', '/directory');
		assert.equal(document.querySelector('#tres-panel'), null, 'leaving the page removes the panel');
		assert.equal(document.querySelectorAll('.tres-hidden, [data-tres]').length, 0, 'and the page decorations');
	}, { url: 'https://www.twitch.tv/drops/inventory' });
});

test('reset all clears filters and claimed marks after confirmation', async () => {
	await withScript('page_source_default.html', ({ window, document, app }) => {
		window.confirm = () => true;
		panelInput(document, 'Hide closed').click();
		app.actions.setGame('arc raiders|embark studios', true);
		assert.equal(app.actions.resetAll(), 'Filters and claimed marks reset.');
		assert.deepEqual(app.state.data.rules, tres.defaultData().rules);
		assert.equal(document.querySelectorAll('.tres-hidden').length, 18);
	});
});

test('own nodes do not count as page mutations', () => {
	const { document } = loadSample('page_source_default.html');
	const own = document.createElement('span');
	own.setAttribute('data-tres', 'x');
	const content = document.querySelector('.drops-root__content');
	assert.equal(tres.isOwnMutation({ type: 'childList', target: content, addedNodes: [own], removedNodes: [] }), true);
	assert.equal(tres.isOwnMutation({ type: 'childList', target: content, addedNodes: [document.createElement('div')], removedNodes: [] }), false);
});

// ---------------------------------------------------------------------------
// Rewards loader (spec §4.5). Twitch's accordion is stubbed: clicking a header opens it
// (closing the others) and fills its body from the stitched opencampaigns sample.
// ---------------------------------------------------------------------------

function stubTwitchAccordion(document, clicks) {
	const source = loadSample('page_source_opencampaigns.html').document;
	const bodies = [...source.querySelectorAll('.accordion-header[role="heading"][aria-level="3"]')].map((h) => h.nextElementSibling.innerHTML);
	const headers = [...document.querySelectorAll('.accordion-header[role="heading"][aria-level="3"]')];
	headers.forEach((header, index) => {
		const toggle = header.querySelector('button[aria-expanded]');
		toggle.addEventListener('click', () => {
			clicks.push(header.querySelector('p').textContent);
			const opening = toggle.getAttribute('aria-expanded') !== 'true';
			for (const other of headers) other.querySelector('button[aria-expanded]').setAttribute('aria-expanded', 'false');
			toggle.setAttribute('aria-expanded', String(opening));
			const body = header.nextElementSibling;
			if (opening && !body.children.length) body.innerHTML = bodies[index];
		});
	});
}

/** Storage that already knows every campaign's rewards except the named games. */
function storageKnowingAllBut(games) {
	const data = tres.defaultData();
	const open = loadSample('page_source_opencampaigns.html');
	tres.learnCampaigns(tres.extractCampaigns(open.document, open.now).campaigns, data, open.now);
	for (const entry of Object.values(data.campaigns)) {
		if (games.some((game) => entry.rewards && entry.rewards[0] && entry.rewards[0].key.startsWith(`${tres.normalize(game)}|`))) {
			entry.rewards = null;
			entry.rewardsSeenAt = null;
		}
	}
	return tres.memoryStorage(data);
}

const buttonText = (document, prefix) => [...document.querySelectorAll('#tres-panel button')].find((b) => b.textContent.startsWith(prefix));

test('loader buttons show how many campaigns they will open', async () => {
	await withScript('page_source_default.html', ({ document }) => {
		assert.equal(buttonText(document, 'Load all').textContent, 'Load all rewards (102)');
		assert.equal(buttonText(document, 'Re-read').textContent, 'Re-read all rewards (102)');
	});
	await withScript('page_source_default.html', ({ document }) => {
		assert.equal(buttonText(document, 'Load all').textContent, 'Load all rewards (2)');
	}, { storage: storageKnowingAllBut(['Enshrouded', 'QSMP']) });
	await withScript('page_source_opencampaigns.html', ({ document }) => {
		const done = buttonText(document, 'All rewards known');
		assert.ok(done && done.disabled);
	});
});

test('Load all rewards opens only unknown campaigns, learns them, and closes the last one', async () => {
	const clicks = [];
	const storage = storageKnowingAllBut(['Enshrouded', 'QSMP']);
	await withScript('page_source_default.html', async ({ document, app }) => {
		await app.actions.loadRewards('unknown');
		// Opened in page order (QSMP, then Enshrouded), then the last one is closed again.
		assert.deepEqual(clicks, ['QSMP', 'Enshrouded', 'Enshrouded']);
		assert.equal(app.state.result.campaigns.filter((c) => !c.rewards).length, 0);
		assert.equal(buttonText(document, 'All rewards known').disabled, true);
		assert.equal(document.querySelectorAll('button[aria-expanded="true"]').length, 0, 'no campaign left open');
		assert.match(document.querySelector('#tres-panel .tres-status').textContent, /^Finished: read 2 of 2\.$/);
		app.flushWrite();
	}, { storage, prepare: (document) => stubTwitchAccordion(document, clicks), loaderPollMs: 5 });
	const stored = Object.values(storage.read().campaigns).filter((entry) => entry.rewards);
	assert.equal(stored.length, 102, 'the newly read rewards were saved');
});

test('the loader reopens the campaign the user had open', async () => {
	const clicks = [];
	await withScript('page_source_default.html', async ({ window, document, app }) => {
		headerOf(document, 'ARC Raiders').querySelector('button').click();
		await wait(window, 200);
		clicks.length = 0;
		await app.actions.loadRewards('unknown');
		assert.equal(headerOf(document, 'ARC Raiders').querySelector('button').getAttribute('aria-expanded'), 'true');
		assert.equal(document.querySelectorAll('button[aria-expanded="true"]').length, 1);
	}, { storage: storageKnowingAllBut(['Enshrouded']), prepare: (document) => stubTwitchAccordion(document, clicks), loaderPollMs: 5 });
});

test('cancelling keeps what was learned and stops opening campaigns', async () => {
	const clicks = [];
	await withScript('page_source_default.html', async ({ window, document, app }) => {
		const running = app.actions.loadRewards('unknown');
		assert.equal(app.state.loader.running, true);
		assert.match(document.querySelector('#tres-panel .tres-pill').textContent, /^TRES · loading 0\/3$/);
		while (app.state.loader.done < 1) await wait(window, 5);
		app.actions.cancelLoad();
		await running;
		assert.equal(app.state.loader.running, false);
		// The campaign open when Cancel was pressed may still be learned by the normal page scan,
		// but no further campaign is opened.
		assert.ok(new Set(clicks).size <= 2, `opened: ${clicks}`);
		assert.ok(app.state.result.campaigns.filter((c) => !c.rewards).length >= 1);
		assert.match(document.querySelector('#tres-panel .tres-status').textContent, /^Cancelled: read 1 of 3\.$/);
	}, { storage: storageKnowingAllBut(['Enshrouded', 'QSMP', 'Palia']), prepare: (document) => stubTwitchAccordion(document, clicks), loaderPollMs: 5 });
});

test('a campaign whose body never loads is reported as a timeout', async () => {
	await withScript('page_source_default.html', async ({ document, app }) => {
		await app.actions.loadRewards('unknown');
		assert.deepEqual(app.state.loader.timeouts, ['Enshrouded']);
		const lines = [...document.querySelectorAll('#tres-panel .tres-diag li')].map((li) => li.textContent);
		assert.ok(lines.includes('Rewards loader timeouts: 1 (Enshrouded)'), lines.join('\n'));
	}, { storage: storageKnowingAllBut(['Enshrouded']), loaderPollMs: 400 });
});

test('the panel stays open while the loader runs', async () => {
	const clicks = [];
	await withScript('page_source_default.html', async ({ window, document, app }) => {
		const panel = document.querySelector('#tres-panel');
		click(window, panel.querySelector('.tres-pill'));
		const running = app.actions.loadRewards('unknown');
		click(window, document.querySelector('.drops-root__content'), 'mousedown');
		assert.equal(panel.dataset.expanded, 'true');
		await running;
		click(window, document.querySelector('.drops-root__content'), 'mousedown');
		assert.equal(panel.dataset.expanded, 'false');
	}, { storage: storageKnowingAllBut(['Enshrouded']), prepare: (document) => stubTwitchAccordion(document, clicks), loaderPollMs: 5 });
});

test('every panel section is collapsible and starts collapsed', async () => {
	await withScript('page_source_default.html', ({ document }) => {
		const sections = [...document.querySelectorAll('#tres-panel .tres-body > details')].map((d) => [d.querySelector('summary').textContent.replace(/ \(\d+\)$/, ''), d.open]);
		assert.deepEqual(sections, [
			['Visibility', false], ['Sorting', false], ['Rewards', false], ['Open campaigns', false], ['Closed campaigns', false],
			['Hidden campaigns', false], ['Claimed rewards', false], ['Backup', false], ['Diagnostics', false]
		]);
		assert.equal(document.querySelectorAll('#tres-panel .tres-body > div.tres-section').length, 0, 'no fixed sections left');
	});
});

// ---------------------------------------------------------------------------
// Sorting (spec §4.6)
// ---------------------------------------------------------------------------

const sortRadio = (document, key) => document.querySelector(`#tres-panel input[name="tres-sort"][value="${key}"]`);
const visualOrder = (container) => [...container.children]
	.map((child, index) => ({ game: child.querySelector('p').textContent, order: Number(child.style.order), index }))
	.sort((a, b) => a.order - b.order || a.index - b.index)
	.map((entry) => entry.game);

test('default "Newest first" orders each section with CSS, without moving any element', async () => {
	await withScript('page_source_default.html', ({ document, app }) => {
		const domBefore = roots(document);
		assert.equal(sortRadio(document, 'newest').checked, true);
		const containers = [...document.querySelectorAll('.tres-sorted')];
		assert.equal(containers.length, 2, 'one per section');
		const open = app.state.result.campaigns.filter((c) => c.type === 'Open Drop Campaign');
		const expected = tres.sortCampaigns(open, 'newest').map((c) => c.game);
		assert.deepEqual(visualOrder(open[0].rootEl.parentElement), expected);
		assert.equal(visualOrder(open[0].rootEl.parentElement)[0], 'Rise Online');
		assert.deepEqual(roots(document), domBefore, 'DOM order unchanged');
	});
});

test('switching to Twitch order removes all sorting; the choice survives a restart', async () => {
	const storage = tres.memoryStorage();
	await withScript('page_source_default.html', ({ document, app }) => {
		sortRadio(document, 'ending').click();
		const open = app.state.result.campaigns.filter((c) => c.type === 'Open Drop Campaign');
		assert.deepEqual(visualOrder(open[0].rootEl.parentElement), tres.sortCampaigns(open, 'ending').map((c) => c.game));
		sortRadio(document, 'twitch').click();
		assert.equal(document.querySelectorAll('.tres-sorted').length, 0);
		assert.ok(roots(document).every((root) => !root.style.order));
		sortRadio(document, 'game').click();
		app.flushWrite();
	}, { storage });
	await withScript('page_source_default.html', ({ document }) => {
		assert.equal(sortRadio(document, 'game').checked, true);
		assert.equal(document.querySelectorAll('.tres-sorted').length, 2);
	}, { storage });
});

test('leaving the page removes the sorting', async () => {
	await withScript('page_source_default.html', ({ window, document }) => {
		assert.equal(document.querySelectorAll('.tres-sorted').length, 2);
		window.history.pushState({}, '', '/directory');
		assert.equal(document.querySelectorAll('.tres-sorted').length, 0);
		assert.ok(roots(document).every((root) => !root.style.order));
	});
});
