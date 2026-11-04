import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

// The samples were captured in a browser at a fixed UTC-7 (America/Vancouver, "PDT" all year).
// Node's own tz data may disagree (it reports GMT-8 for Vancouver in November 2026), so pin
// the tests to the capture offset; this must run before any Date is created.
process.env.TZ = 'Etc/GMT+7';

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCRIPT_PATH = path.join(ROOT, 'TwitchRewardsEnhancementSuite.user.js');

export const tres = require(SCRIPT_PATH);

const cache = new Map();

/** Reads a sample's HTML and the `captured:` time from its header comment. */
export function readSample(name) {
	if (!cache.has(name)) {
		const html = readFileSync(path.join(ROOT, 'samples', name), 'utf8');
		const captured = html.match(/^captured:\s*(\S+)/m);
		if (!captured) throw new Error(`${name} has no "captured:" header line`);
		cache.set(name, { html, now: Date.parse(captured[1]) });
	}
	return cache.get(name);
}

/** A fresh jsdom document for a sample (safe to mutate), plus its capture time. */
export function loadSample(name, url = 'https://www.twitch.tv/drops/campaigns') {
	const { html, now } = readSample(name);
	const dom = new JSDOM(html, { url, pretendToBeVisual: true });
	return { dom, window: dom.window, document: dom.window.document, now };
}

/** Extracts campaigns from a fresh copy of a sample. */
export function extractSample(name) {
	const { document, now } = loadSample(name);
	return { ...tres.extractCampaigns(document, now), document, now };
}

export function byGame(campaigns, game) {
	return campaigns.filter((campaign) => campaign.game === game);
}

export function headerOf(document, game, datePattern) {
	return [...document.querySelectorAll('.accordion-header[role="heading"][aria-level="3"]')]
		.find((header) => header.querySelector('p')?.textContent.trim() === game && (!datePattern || datePattern.test(header.textContent)));
}

export const wait = (window, ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Starts the script on a sample at the sample's capture time (so results don't drift as
 * campaigns end in real life) and always stops it, so timers don't keep Node alive.
 */
export async function withScript(name, run, { url, storage = tres.memoryStorage(), prepare, loaderPollMs, now: at } = {}) {
	const { window, document, now } = loadSample(name, url);
	if (prepare) prepare(document, window);
	const handle = tres.start(window, storage, { now: () => at ?? now, loaderPollMs });
	try {
		return await run({ window, document, handle, app: handle.app, inventory: handle.inventory, storage, now: at ?? now });
	} finally {
		handle.stop();
	}
}

export const click = (window, target, type = 'click') => target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true }));
