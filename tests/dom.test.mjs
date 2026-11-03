import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tres, loadSample } from './helpers.mjs';

/** Starts the script on a sample and always stops it (after async checks finish), so timers don't keep Node alive. */
async function withScript(name, url, run) {
	const { window, document } = loadSample(name, url);
	const handle = tres.start(window, tres.memoryStorage());
	try {
		return await run({ window, document, handle });
	} finally {
		handle.stop();
	}
}

const click = (window, target, type = 'click') => target.dispatchEvent(new window.MouseEvent(type, { bubbles: true }));

test('on the campaigns page: one panel, collapsed, nothing hidden yet', () => {
	withScript('page_source_default.html', undefined, ({ document, handle }) => {
		assert.equal(document.querySelectorAll('#tres-panel').length, 1);
		assert.equal(document.querySelector('#tres-panel').dataset.expanded, 'false');
		assert.equal(document.querySelector('#tres-panel .tres-pill').textContent, 'TRES · 102 campaigns');
		assert.equal(document.querySelectorAll('.tres-hidden').length, 0);
		assert.equal(handle.app.state.result.campaigns.length, 102);
	});
});

test('panel: pill expands, outside click and Esc collapse', () => {
	withScript('page_source_default.html', undefined, ({ window, document }) => {
		const panel = document.querySelector('#tres-panel');
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

test('diagnostics: header and parse counts are shown', () => {
	withScript('page_source_default.html', undefined, ({ document }) => {
		const lines = [...document.querySelectorAll('#tres-panel .tres-diag li')].map((li) => li.textContent);
		assert.ok(lines.includes('Headers found: 102 · campaigns parsed: 102'), lines.join('\n'));
		assert.ok(document.querySelector('#tres-panel .tres-warning').hidden);
	});
});

test('unrecognised headings show the English warning', () => {
	const { window, document } = loadSample('page_source_default.html');
	for (const heading of document.querySelectorAll('h4')) heading.textContent = 'Kampagnen';
	const handle = tres.start(window, tres.memoryStorage());
	try {
		assert.equal(document.querySelector('#tres-panel .tres-warning').hidden, false);
		assert.equal(document.querySelector('#tres-panel .tres-pill').textContent, 'TRES · !');
	} finally {
		handle.stop();
	}
});

test('the script stays inactive on the Inventory page and starts after navigating to campaigns', () => {
	withScript('page_source_default.html', 'https://www.twitch.tv/drops/inventory', ({ window, document }) => {
		assert.equal(document.querySelector('#tres-panel'), null);
		window.history.pushState({}, '', '/drops/campaigns');
		assert.equal(document.querySelectorAll('#tres-panel').length, 1);
		window.history.pushState({}, '', '/directory');
		assert.equal(document.querySelector('#tres-panel'), null, 'leaving the page removes the panel');
	});
});

test('mutations: opening a campaign re-parses only that campaign', async () => {
	await withScript('page_source_default.html', undefined, async ({ window, document, handle }) => {
		const header = [...document.querySelectorAll('.accordion-header')].find((h) => h.querySelector('p').textContent === 'Enshrouded');
		const before = handle.app.state.result.campaigns.find((c) => c.game === 'Enshrouded');
		const untouched = handle.app.state.result.campaigns.find((c) => c.game === 'ARC Raiders');
		header.querySelector('button').setAttribute('aria-expanded', 'true');
		await new Promise((resolve) => window.setTimeout(resolve, 250));
		const result = handle.app.state.result;
		const after = result.campaigns.find((c) => c.game === 'Enshrouded');
		assert.equal(after.expanded, true);
		assert.equal(after.id, before.id);
		assert.notEqual(after, before, 'the changed campaign was re-parsed');
		assert.equal(result.campaigns.find((c) => c.game === 'ARC Raiders'), untouched, 'others were reused from the cache');
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
