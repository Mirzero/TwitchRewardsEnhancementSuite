// ==UserScript==
// @name         Twitch Drops Campaign Filters
// @namespace    https://github.com/Mirzero/TwitchRewardsEnhancementSuite
// @version      0.5.0
// @description  Hide Twitch Drops campaigns you don't care about or have already finished.
// @author       Mirzero
// @homepageURL  https://github.com/Mirzero/TwitchRewardsEnhancementSuite
// @supportURL   https://github.com/Mirzero/TwitchRewardsEnhancementSuite/issues
// @updateURL    https://raw.githubusercontent.com/Mirzero/TwitchRewardsEnhancementSuite/main/TRES-DropCampaigns.user.js
// @downloadURL  https://raw.githubusercontent.com/Mirzero/TwitchRewardsEnhancementSuite/main/TRES-DropCampaigns.user.js
// @match        https://www.twitch.tv/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
	'use strict';

	// =====================================================================
	// 1. Constants and utilities
	// =====================================================================

	const LOG_PREFIX = '[TRES Drop Campaigns]';
	const STORAGE_KEY = 'tresDropCampaigns.v2';
	const CAMPAIGNS_PATH = '/drops/campaigns';
	const CONTENT_SELECTOR = '.drops-root__content';
	const HEADER_SELECTOR = '.accordion-header[role="heading"][aria-level="3"]';
	const CLOSED_TYPE = 'Closed Drop Campaign';
	const CLOSED_WATERMARK = 'This campaign has closed.';
	const REDEEM_LABELS = { 'watch to redeem': 'watch', 'subscribe to redeem': 'subscribe' };
	// <h4> section heading (normalized) -> campaign type. English only (spec §2.1).
	const SECTION_TYPES = {
		'open reward campaigns': 'Open Reward Campaign',
		'open drop campaigns': 'Open Drop Campaign',
		'closed drop campaigns': CLOSED_TYPE
	};
	const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
	// Reward art lives under /REWARD/{uuid}.png, badge art under /badges/v1/{uuid}/. Placeholders (REWARD/default.png) have no uuid.
	const REWARD_UUID_RE = /\/(?:REWARD|badges\/v1)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
	const DATE_PART = '[A-Za-z]{3},\\s+([A-Za-z]{3})\\s+(\\d{1,2}),\\s+(\\d{1,2}):(\\d{2})\\s*([AP]M)(?:\\s+([A-Z]{2,5}))?';
	const DATE_RANGE_RE = new RegExp(`^${DATE_PART}\\s*-\\s*${DATE_PART}$`, 'i');
	const SCAN_DEBOUNCE_MS = 150;
	const ROUTE_POLL_MS = 1000;
	const STATUS_TICK_MS = 60 * 1000;
	const CONTENT_WAIT_MS = 300;

	function clean(value) {
		return String(value ?? '').replace(/\s+/g, ' ').trim();
	}

	function normalize(value) {
		return clean(value).normalize('NFC').toLowerCase();
	}

	function textOf(node) {
		return node ? clean(node.textContent) : '';
	}

	function isCampaignsPath(pathname) {
		return String(pathname || '').startsWith(CAMPAIGNS_PATH);
	}

	/**
	 * Parses a header date range such as "Thu, Oct 8, 4:00 AM - Wed, Nov 4, 5:44 AM PDT".
	 * Times are browser-local (spec §2.3); the label is kept only for diagnostics.
	 * There is no year: the start takes the year closest to `now`, and the end rolls
	 * into the next year if it would otherwise precede the start.
	 * Returns { start, end, startTz, endTz } in epoch ms, or null if unparseable.
	 */
	function parseDateRange(text, now) {
		const match = clean(text).match(DATE_RANGE_RE);
		if (!match) return null;
		const startParts = dateParts(match.slice(1, 7));
		const endParts = dateParts(match.slice(7, 13));
		if (!startParts || !endParts) return null;
		const nowYear = new Date(now).getFullYear();
		let best = null;
		for (const year of [nowYear - 1, nowYear, nowYear + 1]) {
			const time = localTime(year, startParts);
			if (time === null) continue;
			if (!best || Math.abs(time - now) < Math.abs(best.time - now)) best = { year, time };
		}
		if (!best) return null;
		let end = localTime(best.year, endParts);
		if (end !== null && end < best.time) end = localTime(best.year + 1, endParts);
		if (end === null) return null;
		return { start: best.time, end, startTz: startParts.tz, endTz: endParts.tz };
	}

	function dateParts([month, day, hour, minute, meridiem, tz]) {
		const monthIndex = MONTHS.indexOf(month.toLowerCase());
		if (monthIndex < 0) return null;
		let hours = Number(hour) % 12;
		if (meridiem.toUpperCase() === 'PM') hours += 12;
		return { month: monthIndex, day: Number(day), hours, minutes: Number(minute), tz: tz ? tz.toUpperCase() : null };
	}

	function localTime(year, parts) {
		const date = new Date(year, parts.month, parts.day, parts.hours, parts.minutes);
		// Reject overflow such as "Feb 30" instead of silently rolling into March.
		return date.getMonth() === parts.month && date.getDate() === parts.day ? date.getTime() : null;
	}

	/** The browser's short timezone name at a moment, e.g. "PDT", or null if unavailable. */
	function localTzName(time) {
		try {
			const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date(time));
			return parts.find((part) => part.type === 'timeZoneName')?.value || null;
		} catch (error) {
			return null;
		}
	}

	// =====================================================================
	// 2. Data model
	// =====================================================================

	function gameKeyOf(game, publisher) {
		return `${normalize(game)}|${normalize(publisher)}`;
	}

	function publisherKeyOf(publisher) {
		return normalize(publisher);
	}

	/**
	 * Campaign id = gameKey + parsed start/end (spec §3). The section is deliberately
	 * excluded so a campaign keeps its id when Twitch moves it from Open to Closed.
	 */
	function campaignIdOf(gameKey, dates, dateText) {
		return dates ? `${gameKey}|${dates.start}|${dates.end}` : `${gameKey}|${normalize(dateText)}`;
	}

	function rewardKeyOf(campaignId, imageUuid, name, occurrence) {
		return `${campaignId}|${imageUuid || ''}|${normalize(name)}|${occurrence}`;
	}

	function statusOf(campaign, now) {
		if (campaign.start === null) return null;
		if (now < campaign.start) return 'upcoming';
		if (campaign.end !== null && now > campaign.end) return 'ended';
		return 'active';
	}

	/** Sets the time-dependent fields; called on every scan so statuses follow the clock. */
	function applyTime(campaign, now) {
		campaign.status = statusOf(campaign, now);
		campaign.closed = campaign.type === CLOSED_TYPE || (campaign.end !== null && campaign.end < now);
		return campaign;
	}

	/** A copy of a campaign without live DOM references, safe to serialize. */
	function plainCampaign(campaign) {
		const { rootEl, ...rest } = campaign;
		return {
			...rest,
			rewards: campaign.rewards ? campaign.rewards.map(({ tileEl, ...reward }) => reward) : null
		};
	}

	// =====================================================================
	// 3. Extraction (pure: reads the DOM, never writes it)
	// =====================================================================

	function findContent(root) {
		if (!root) return null;
		if (root.matches && root.matches(CONTENT_SELECTOR)) return root;
		return root.querySelector(CONTENT_SELECTOR);
	}

	function emptyDiagnostics() {
		return {
			headers: 0,
			failures: [],
			unknownHeadings: [],
			dateFailures: 0,
			tzMismatches: 0
		};
	}

	/**
	 * Extracts every campaign under `.drops-root__content`.
	 * Returns { found, recognized, campaigns, diagnostics }.
	 * `reuse(header, type)` may return a previously parsed campaign to skip re-parsing.
	 */
	function walkCampaigns(root, now, reuse) {
		const content = findContent(root);
		const result = { found: Boolean(content), recognized: false, campaigns: [], diagnostics: emptyDiagnostics() };
		if (!content) return result;
		const diagnostics = result.diagnostics;
		const seenIds = new Set();
		let currentType = null;
		// querySelectorAll returns document order, so each header follows its section's <h4>.
		for (const node of content.querySelectorAll(`h4, ${HEADER_SELECTOR}`)) {
			if (node.tagName === 'H4') {
				const heading = textOf(node);
				currentType = SECTION_TYPES[normalize(heading)] || null;
				if (currentType) result.recognized = true;
				else diagnostics.unknownHeadings.push(heading);
				continue;
			}
			diagnostics.headers += 1;
			const parsed = (reuse && reuse(node, currentType)) || parseCampaign(node, currentType, now);
			if (parsed.error) {
				diagnostics.failures.push({ reason: parsed.error, text: textOf(node).slice(0, 80) });
				continue;
			}
			const campaign = parsed.campaign;
			if (seenIds.has(campaign.id)) {
				diagnostics.failures.push({ reason: 'duplicate campaign id', text: textOf(node).slice(0, 80) });
				continue;
			}
			seenIds.add(campaign.id);
			if (!campaign.dates) diagnostics.dateFailures += 1;
			if (campaign.tzMismatch) diagnostics.tzMismatches += 1;
			result.campaigns.push(applyTime(campaign, now));
		}
		return result;
	}

	function extractCampaigns(root, now) {
		return walkCampaigns(root, now, null);
	}

	/** Parses one campaign header (and its body, if loaded). Returns { campaign } or { error }. */
	function parseCampaign(header, type, now) {
		if (!type) return { error: 'not under a recognised section heading' };
		const paragraphs = header.querySelectorAll('p');
		const game = textOf(paragraphs[0]) || clean(header.querySelector('img')?.getAttribute('alt'));
		const publisher = textOf(paragraphs[1]);
		if (!game) return { error: 'no game name' };
		if (!publisher) return { error: 'no publisher name' };
		const dateText = findDateText(header);
		if (!dateText) return { error: 'no date range' };

		const dates = parseDateRange(dateText, now);
		const gameKey = gameKeyOf(game, publisher);
		const id = campaignIdOf(gameKey, dates, dateText);
		const tzLabel = dates && (dates.endTz || dates.startTz);
		const body = header.nextElementSibling;
		const details = body && body.children.length ? extractBody(body) : null;

		const campaign = {
			id,
			type,
			closed: false,
			game,
			publisher,
			gameKey,
			publisherKey: publisherKeyOf(publisher),
			start: dates ? dates.start : null,
			end: dates ? dates.end : null,
			dateText,
			dates: Boolean(dates),
			tzMismatch: Boolean(tzLabel && localTzName(dates.end) && tzLabel !== localTzName(dates.end)),
			status: null,
			bodyLoaded: Boolean(details),
			title: details ? details.title : null,
			redeem: details ? details.redeem : null,
			connection: details ? details.connection : null,
			rewards: details && details.rewards ? keyRewards(id, details.rewards) : null,
			rewardsUnreadable: Boolean(details && !details.rewards),
			rewardTiles: details ? details.rewardTiles : 0,
			closedWatermarks: details ? details.closedWatermarks : 0,
			expanded: header.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') === 'true',
			rootEl: header.parentElement
		};
		return { campaign };
	}

	function findDateText(header) {
		for (const div of header.querySelectorAll('div')) {
			if (div.children.length) continue;
			const text = textOf(div);
			if (DATE_RANGE_RE.test(text)) return text;
		}
		return null;
	}

	/** Reads a loaded campaign body: title, redeem line, connection state and rewards. */
	function extractBody(body) {
		const titleNode = [...body.querySelectorAll('strong')].find((node) => !node.closest('.drop-details__label'));
		const leafTexts = [...body.querySelectorAll('div, span, p')].filter((node) => !node.children.length).map(textOf);
		const redeem = [...new Set(leafTexts.map((text) => REDEEM_LABELS[normalize(text)]).filter(Boolean))];

		const connectionLabel = [...body.querySelectorAll('.drop-details__label')]
			.find((label) => textOf(label.querySelector('strong')).startsWith('Connection'));
		let connection = 'none';
		if (connectionLabel) {
			// The state ("Connected" pill or "Connect" button) sits beside the label, not inside it.
			const states = [...connectionLabel.parentElement.querySelectorAll('.tw-pill, [data-a-target="tw-core-button-label-text"]')].map(textOf);
			connection = states.includes('Connected') ? 'connected' : 'required';
		}

		const containers = [...body.querySelectorAll('.drop-benefit__image-container')];
		let readable = containers.length > 0;
		let closedWatermarks = 0;
		const rewards = containers.map((container) => {
			const tile = container.parentElement;
			const name = textOf(tile.querySelector('p'));
			const type = textOf(tile.querySelector('span.tw-pill'));
			const src = container.querySelector('img')?.getAttribute('src') || '';
			const closedMark = [...tile.querySelectorAll('div')].some((div) => !div.children.length && textOf(div) === CLOSED_WATERMARK);
			if (closedMark) closedWatermarks += 1;
			if (!name || !type) readable = false;
			return { name, type, imageUuid: (src.match(REWARD_UUID_RE)?.[1] || '').toLowerCase() || null, closedMark, tileEl: tile };
		});

		return {
			title: titleNode ? textOf(titleNode) : null,
			redeem: redeem.length ? redeem : null,
			connection,
			// Unreadable or missing tiles mean "unknown", never a guess (spec §2.2).
			rewards: readable ? rewards : null,
			rewardTiles: containers.length,
			closedWatermarks
		};
	}

	function keyRewards(campaignId, rewards) {
		const occurrences = new Map();
		return rewards.map((reward) => {
			const base = `${reward.imageUuid}|${normalize(reward.name)}`;
			const occurrence = occurrences.get(base) || 0;
			occurrences.set(base, occurrence + 1);
			return { key: rewardKeyOf(campaignId, reward.imageUuid, reward.name, occurrence), ...reward };
		});
	}

	/** Aggregate counts for the diagnostics subpanel (spec §7). */
	function summarize(result) {
		const campaigns = result.campaigns;
		const groups = { open: campaigns.filter((c) => c.type !== CLOSED_TYPE), closed: campaigns.filter((c) => c.type === CLOSED_TYPE) };
		const byType = {};
		const tilesByType = {};
		let rewardsKnown = 0;
		let unreadable = 0;
		let watermarks = 0;
		for (const campaign of campaigns) {
			byType[campaign.type] = (byType[campaign.type] || 0) + 1;
			if (campaign.rewards) rewardsKnown += 1;
			if (campaign.rewardsUnreadable) unreadable += 1;
			watermarks += campaign.closedWatermarks;
			for (const reward of campaign.rewards || []) tilesByType[reward.type] = (tilesByType[reward.type] || 0) + 1;
		}
		const distinct = (list, key) => new Set(list.map((c) => c[key])).size;
		return {
			headers: result.diagnostics.headers,
			parsed: campaigns.length,
			closed: campaigns.filter((c) => c.closed).length,
			byType,
			games: { open: distinct(groups.open, 'gameKey'), closed: distinct(groups.closed, 'gameKey'), all: distinct(campaigns, 'gameKey') },
			publishers: { open: distinct(groups.open, 'publisherKey'), closed: distinct(groups.closed, 'publisherKey'), all: distinct(campaigns, 'publisherKey') },
			rewardsKnown,
			unreadable,
			tilesByType,
			watermarks,
			dateFailures: result.diagnostics.dateFailures,
			tzMismatches: result.diagnostics.tzMismatches,
			unknownHeadings: result.diagnostics.unknownHeadings,
			failures: result.diagnostics.failures
		};
	}

	// =====================================================================
	// 4. Filter model and storage (filters arrive in stage 2)
	// =====================================================================

	function gmStorage() {
		return {
			read: () => GM_getValue(STORAGE_KEY, null),
			write: (value) => GM_setValue(STORAGE_KEY, value)
		};
	}

	function memoryStorage(initial = null) {
		let value = initial;
		return { read: () => value, write: (next) => { value = next; } };
	}

	// =====================================================================
	// 5. Rendering
	// =====================================================================

	const PANEL_CSS = `
#tres-panel{position:fixed;top:calc(5rem + 8px);right:16px;z-index:1000;font:13px/1.4 Inter,Roobert,'Helvetica Neue',Helvetica,Arial,sans-serif;color:#efeff1}
#tres-panel *{box-sizing:border-box}
#tres-panel .tres-pill{display:block;margin-left:auto;padding:4px 10px;border:1px solid #3d3d42;border-radius:999px;background:#18181b;color:#efeff1;font:inherit;font-weight:600;cursor:pointer;opacity:.85}
#tres-panel .tres-pill:hover{opacity:1;border-color:#a970ff}
#tres-panel .tres-body{width:min(380px,calc(100vw - 32px));max-height:calc(100vh - 7rem);overflow:auto;padding:12px;border:1px solid #3d3d42;border-radius:6px;background:#18181b;box-shadow:0 8px 24px rgba(0,0,0,.5)}
#tres-panel[data-expanded="false"] .tres-body{display:none}
#tres-panel[data-expanded="true"] .tres-pill{display:none}
#tres-panel .tres-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
#tres-panel .tres-head strong{font-size:14px}
#tres-panel button.tres-btn{padding:3px 8px;border:0;border-radius:4px;background:#3d3d42;color:#efeff1;font:inherit;cursor:pointer}
#tres-panel button.tres-btn:hover{background:#53535f}
#tres-panel .tres-warning{margin:0 0 8px;padding:8px;border-radius:4px;background:#5c1a1a;color:#ffd4d4}
#tres-panel .tres-summary{margin:0 0 8px;color:#bf94ff}
#tres-panel details{margin-top:8px;border-top:1px solid #3d3d42;padding-top:6px}
#tres-panel summary{cursor:pointer;font-weight:600}
#tres-panel .tres-diag{margin:6px 0;padding:0;list-style:none;color:#adadb8}
#tres-panel .tres-diag li{margin:2px 0;overflow-wrap:anywhere}
#tres-panel .tres-diag .tres-bad{color:#ff8280}
#tres-panel .tres-status{min-height:1em;margin:4px 0 0;color:#adadb8}
`;

	function createPanel(doc, actions) {
		const style = doc.createElement('style');
		style.id = 'tres-style';
		style.setAttribute('data-tres', 'style');
		style.textContent = PANEL_CSS;
		doc.head.appendChild(style);

		const panel = doc.createElement('div');
		panel.id = 'tres-panel';
		panel.setAttribute('data-tres', 'panel');
		panel.dataset.expanded = 'false';

		const pill = element(doc, 'button', 'tres-pill', 'TRES');
		pill.type = 'button';
		pill.title = 'Drop campaign filters';

		const body = element(doc, 'div', 'tres-body');
		const head = element(doc, 'div', 'tres-head');
		const collapse = element(doc, 'button', 'tres-btn', '–');
		collapse.type = 'button';
		collapse.title = 'Collapse';
		head.append(element(doc, 'strong', '', 'Drop campaign filters'), collapse);

		const warning = element(doc, 'p', 'tres-warning', 'Unrecognised page. Is Twitch set to English?');
		warning.hidden = true;
		const summary = element(doc, 'p', 'tres-summary');

		const diagnostics = element(doc, 'details', 'tres-diagnostics');
		diagnostics.append(element(doc, 'summary', '', 'Diagnostics'));
		const diagList = element(doc, 'ul', 'tres-diag');
		const copyButton = element(doc, 'button', 'tres-btn', 'Copy model as JSON');
		copyButton.type = 'button';
		const copyStatus = element(doc, 'p', 'tres-status');
		diagnostics.append(diagList, copyButton, copyStatus);

		body.append(head, warning, summary, diagnostics);
		panel.append(pill, body);
		doc.body.appendChild(panel);

		const setExpanded = (expanded) => { panel.dataset.expanded = String(expanded); };
		pill.addEventListener('click', () => setExpanded(true));
		collapse.addEventListener('click', () => setExpanded(false));
		copyButton.addEventListener('click', async () => {
			copyStatus.textContent = (await actions.copyModel()) ? 'Copied.' : 'Copy failed; the model was logged to the console.';
		});
		const onMouseDown = (event) => {
			if (panel.dataset.expanded === 'true' && !panel.contains(event.target) && !isFocusedInput(doc, panel)) setExpanded(false);
		};
		const onKeyDown = (event) => {
			if (event.key === 'Escape' && panel.dataset.expanded === 'true') setExpanded(false);
		};
		doc.addEventListener('mousedown', onMouseDown, true);
		doc.addEventListener('keydown', onKeyDown, true);

		let lastSignature = '';
		return {
			element: panel,
			isExpanded: () => panel.dataset.expanded === 'true',
			setExpanded,
			update(view) {
				const signature = JSON.stringify(view);
				if (signature === lastSignature) return;
				lastSignature = signature;
				pill.textContent = view.recognized ? `TRES · ${view.summary.parsed} campaigns` : 'TRES · !';
				warning.hidden = view.recognized || !view.found;
				summary.textContent = `${view.summary.parsed} campaigns (${view.summary.closed} closed)`;
				diagList.replaceChildren(...diagnosticLines(view).map(([text, bad]) => {
					const item = element(doc, 'li', bad ? 'tres-bad' : '', text);
					return item;
				}));
			},
			destroy() {
				doc.removeEventListener('mousedown', onMouseDown, true);
				doc.removeEventListener('keydown', onKeyDown, true);
				panel.remove();
				style.remove();
			}
		};
	}

	function diagnosticLines(view) {
		const s = view.summary;
		const lines = [];
		lines.push([`Headers found: ${s.headers} · campaigns parsed: ${s.parsed}`, s.headers !== s.parsed]);
		if (s.unknownHeadings.length) lines.push([`Unrecognised headings: ${s.unknownHeadings.join(' | ')}`, true]);
		lines.push([`By section: ${Object.entries(s.byType).map(([type, count]) => `${type} ${count}`).join(' · ') || 'none'}`]);
		lines.push([`Games: ${s.games.open} open · ${s.games.closed} closed · ${s.games.all} total`]);
		lines.push([`Publishers: ${s.publishers.open} open · ${s.publishers.closed} closed · ${s.publishers.all} total`]);
		lines.push([`Rewards known for ${s.rewardsKnown} / ${s.parsed} campaigns`]);
		lines.push([`Loaded bodies with unreadable rewards: ${s.unreadable}`, s.unreadable > 0]);
		lines.push([`Reward tiles by type: ${Object.entries(s.tilesByType).map(([type, count]) => `${type} ${count}`).join(' · ') || 'none yet'}`]);
		lines.push([`Tiles with closed watermark: ${s.watermarks}`]);
		lines.push([`Dates that failed to parse: ${s.dateFailures}`, s.dateFailures > 0]);
		lines.push([`Timezone label mismatches: ${s.tzMismatches}`, s.tzMismatches > 0]);
		for (const failure of s.failures) lines.push([`Failed: ${failure.reason} — ${failure.text}`, true]);
		lines.push([`Last scan: ${view.lastScanAt} (${view.scanMs} ms)`]);
		return lines;
	}

	function element(doc, tag, className, text) {
		const node = doc.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function isFocusedInput(doc, panel) {
		const active = doc.activeElement;
		return Boolean(active && panel.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
	}

	// =====================================================================
	// 6. Orchestration
	// =====================================================================

	/** Re-parses only campaigns that are new, moved to another section, or marked dirty. */
	function createScanner() {
		const cache = new WeakMap();
		return {
			scan(root, now, dirtyRoots) {
				return walkCampaigns(root, now, (header, type) => {
					const cached = cache.get(header);
					if (cached && cached.type === type && !dirtyRoots.has(header.parentElement)) return cached.parsed;
					const parsed = parseCampaign(header, type, now);
					cache.set(header, { type, parsed });
					return parsed;
				});
			}
		};
	}

	/** The campaign root containing `node`: the element whose first child is a campaign header. */
	function campaignRootOf(node, content) {
		let current = node && node.nodeType === 1 ? node : node && node.parentElement;
		while (current && current !== content) {
			const first = current.firstElementChild;
			if (first && first.matches(HEADER_SELECTOR)) return current;
			current = current.parentElement;
		}
		return null;
	}

	function isOwnMutation(mutation) {
		const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
		if (target && target.closest('[data-tres]')) return true;
		if (mutation.type !== 'childList') return false;
		const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
		return nodes.length > 0 && nodes.every((node) => node.nodeType === 1 && node.hasAttribute('data-tres'));
	}

	function createApp(win, storage) {
		const doc = win.document;
		const state = {
			active: false,
			content: null,
			observer: null,
			scanner: null,
			panel: null,
			dirty: new Set(),
			result: null,
			lastScanAt: null,
			scanMs: 0,
			timers: { scan: 0, wait: 0, tick: 0 }
		};

		function route() {
			const wanted = isCampaignsPath(win.location.pathname);
			if (wanted && !state.active) activate();
			else if (!wanted && state.active) deactivate();
			else if (wanted && state.content && doc.querySelector(CONTENT_SELECTOR) !== state.content) reattach();
		}

		function activate() {
			state.active = true;
			state.scanner = createScanner();
			state.panel = createPanel(doc, { copyModel });
			waitForContent();
			state.timers.tick = win.setInterval(() => scanNow(), STATUS_TICK_MS);
		}

		function deactivate() {
			state.active = false;
			win.clearTimeout(state.timers.scan);
			win.clearTimeout(state.timers.wait);
			win.clearInterval(state.timers.tick);
			if (state.observer) state.observer.disconnect();
			if (state.panel) state.panel.destroy();
			Object.assign(state, { content: null, observer: null, scanner: null, panel: null, result: null });
			state.dirty.clear();
		}

		function waitForContent() {
			const content = doc.querySelector(CONTENT_SELECTOR);
			if (content) attach(content);
			else state.timers.wait = win.setTimeout(waitForContent, CONTENT_WAIT_MS);
		}

		function attach(content) {
			state.content = content;
			state.observer = new win.MutationObserver(onMutations);
			state.observer.observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] });
			scanNow();
		}

		function reattach() {
			if (state.observer) state.observer.disconnect();
			state.scanner = createScanner();
			state.content = null;
			waitForContent();
		}

		function onMutations(mutations) {
			let relevant = false;
			for (const mutation of mutations) {
				if (isOwnMutation(mutation)) continue;
				relevant = true;
				const campaignRoot = campaignRootOf(mutation.target, state.content);
				if (campaignRoot) state.dirty.add(campaignRoot);
			}
			if (relevant) scheduleScan();
		}

		function scheduleScan() {
			win.clearTimeout(state.timers.scan);
			state.timers.scan = win.setTimeout(scanNow, SCAN_DEBOUNCE_MS);
		}

		function scanNow() {
			if (!state.active || !state.content) return null;
			const started = Date.now();
			state.result = state.scanner.scan(state.content, started, state.dirty);
			state.dirty.clear();
			state.scanMs = Date.now() - started;
			state.lastScanAt = new Date(started).toLocaleTimeString();
			state.panel.update({
				found: state.result.found,
				recognized: state.result.recognized,
				summary: summarize(state.result),
				lastScanAt: state.lastScanAt,
				scanMs: state.scanMs
			});
			return state.result;
		}

		async function copyModel() {
			const json = JSON.stringify({
				capturedAt: new Date().toISOString(),
				url: win.location.href,
				summary: state.result ? summarize(state.result) : null,
				campaigns: state.result ? state.result.campaigns.map(plainCampaign) : [],
				stored: storage ? storage.read() : null
			}, null, 2);
			try {
				await win.navigator.clipboard.writeText(json);
				return true;
			} catch (error) {
				console.log(LOG_PREFIX, 'model:', json);
				return false;
			}
		}

		return { route, scanNow, deactivate, state };
	}

	/** Starts the script in `win`. Returns a handle with stop() for tests. */
	function start(win, storage) {
		const app = createApp(win, storage);
		const history = win.history;
		const originals = { pushState: history.pushState, replaceState: history.replaceState };
		for (const name of Object.keys(originals)) {
			history[name] = function (...args) {
				const result = originals[name].apply(this, args);
				app.route();
				return result;
			};
		}
		const onPopState = () => app.route();
		win.addEventListener('popstate', onPopState);
		// Fallback for route changes the history hooks can't see (e.g. sandboxed userscript scope).
		const routePoll = win.setInterval(() => app.route(), ROUTE_POLL_MS);
		app.route();
		return {
			app,
			stop() {
				win.clearInterval(routePoll);
				win.removeEventListener('popstate', onPopState);
				Object.assign(history, originals);
				app.deactivate();
			}
		};
	}

	const api = {
		clean,
		normalize,
		parseDateRange,
		gameKeyOf,
		publisherKeyOf,
		campaignIdOf,
		rewardKeyOf,
		statusOf,
		plainCampaign,
		extractCampaigns,
		extractBody,
		summarize,
		campaignRootOf,
		isOwnMutation,
		memoryStorage,
		start
	};

	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	else start(window, gmStorage());
})();
