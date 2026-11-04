// ==UserScript==
// @name         Twitch Rewards Enhancement Suite
// @namespace    https://github.com/Mirzero/TwitchRewardsEnhancementSuite
// @version      0.9.0
// @description  Twitch Drops and rewards tools: hide, sort and track campaigns you don't care about or have already finished.
// @author       Mirzero
// @homepageURL  https://github.com/Mirzero/TwitchRewardsEnhancementSuite
// @supportURL   https://github.com/Mirzero/TwitchRewardsEnhancementSuite/issues
// @updateURL    https://raw.githubusercontent.com/Mirzero/TwitchRewardsEnhancementSuite/main/TwitchRewardsEnhancementSuite.user.js
// @downloadURL  https://raw.githubusercontent.com/Mirzero/TwitchRewardsEnhancementSuite/main/TwitchRewardsEnhancementSuite.user.js
// @match        https://www.twitch.tv/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @run-at       document-idle
// ==/UserScript==

(function () {
	'use strict';

	// =====================================================================
	// 1. Constants and utilities
	// =====================================================================

	const LOG_PREFIX = '[TRES Drop Campaigns]';
	// Brand colour: the border of everything TRES injects into Twitch's page (spec §4.7).
	const BRAND_COLOR = '#99ff33';
	const STORAGE_KEY = 'tresDropCampaigns.v2';
	const SCHEMA = 2;
	// The Inventory snapshot has its own key, written only by the Inventory tab (spec §11.6).
	const INVENTORY_KEY = 'tresInventory.v1';
	const INVENTORY_SCHEMA = 1;
	const CAMPAIGNS_PATH = '/drops/campaigns';
	const INVENTORY_PATH = '/drops/inventory';
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
	const WRITE_DEBOUNCE_MS = 300;
	const ROUTE_POLL_MS = 1000;
	const STATUS_TICK_MS = 60 * 1000;
	const CONTENT_WAIT_MS = 300;
	// Rewards loader (spec §4.5): poll an opened body until it has stopped changing.
	const LOADER_POLL_MS = 200;
	const LOADER_STABLE_POLLS = 3;
	const LOADER_MAX_WAIT_MS = 8000;
	const MINUTE_MS = 60 * 1000;
	const HOUR_MS = 60 * MINUTE_MS;
	const DAY_MS = 24 * HOUR_MS;
	// Inventory page text (spec §11.1). English only, like the section headings.
	const CLAIM_ALT_PREFIX = 'Drop image for ';
	const LOAD_MORE_TEXT = 'Load More';
	const CLAIM_NOW_TEXT = 'Claim Now';
	const CONNECT_TEXT = 'Connect';
	const CAPTION_RE = /^(\d+)% of (.+)$/;
	const REWARD_IMAGE_SELECTOR = 'img.inventory-drop-image:not([alt^="Drop image for"])';
	const CLAIM_IMAGE_SELECTOR = 'img.inventory-drop-image[alt^="Drop image for"]';
	// Write the snapshot again after this long even if nothing changed, so "last read" stays honest.
	const INVENTORY_REFRESH_MS = 60 * 1000;
	const PRUNE_AFTER_MS = 60 * DAY_MS;
	// lastSeen only needs coarse precision; this keeps scans from causing storage writes.
	const LAST_SEEN_RESOLUTION_MS = 6 * 60 * 60 * 1000;
	// Sort orders within each section (spec §4.6); the first is the default.
	const SORT_OPTIONS = [
		['newest', 'Newest first'],
		['twitch', 'Twitch order (oldest first)'],
		['ending', 'Ending soonest'],
		['game', 'Game A–Z'],
		['publisher', 'Publisher A–Z']
	];
	const SORT_KEYS = SORT_OPTIONS.map(([key]) => key);
	const REASON_LABELS = {
		campaign: 'campaign',
		game: 'game',
		publisher: 'publisher',
		closed: 'closed',
		upcoming: 'upcoming',
		rewards: 'all rewards done'
	};

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

	function isInventoryPath(pathname) {
		return String(pathname || '').startsWith(INVENTORY_PATH);
	}

	function imageUuidOf(src) {
		return (String(src || '').match(REWARD_UUID_RE)?.[1] || '').toLowerCase() || null;
	}

	function clone(value) {
		return JSON.parse(JSON.stringify(value));
	}

	function isPlainObject(value) {
		return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

	/**
	 * The absolute window [earliest, latest] (epoch ms) in which a claim with Twitch's relative
	 * time text happened, measured from `readAt` (spec §11.2). Twitch rounds down, so "N hours
	 * ago" means N to N+1 hours. Returns null for text it doesn't recognise.
	 */
	function relativeWindow(text, readAt) {
		const value = normalize(text);
		if (/^(just now|now|\d+ seconds? ago)$/.test(value)) return { earliest: readAt - MINUTE_MS, latest: readAt };
		if (value === 'yesterday') return { earliest: readAt - 2 * DAY_MS, latest: readAt - DAY_MS };
		if (value === 'last month') return { earliest: readAt - 61 * DAY_MS, latest: readAt - 28 * DAY_MS };
		const match = value.match(/^(\d+|an?) (minute|hour|day|month)s? ago$/);
		if (!match) return null;
		const count = /^an?$/.test(match[1]) ? 1 : Number(match[1]);
		// Month rounding is unconfirmed, so month windows stay wide.
		if (match[2] === 'month') return { earliest: readAt - (count + 1) * 31 * DAY_MS, latest: readAt - Math.max(0, count - 1) * 28 * DAY_MS };
		const unit = { minute: MINUTE_MS, hour: HOUR_MS, day: DAY_MS }[match[2]];
		return { earliest: readAt - (count + 1) * unit, latest: readAt - count * unit };
	}

	function localDateStamp(time) {
		const date = new Date(time);
		const pad = (value) => String(value).padStart(2, '0');
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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
	 * Returns { found, recognized, campaigns, sections, diagnostics }.
	 * `reuse(header, type)` may return a previously parsed campaign to skip re-parsing.
	 */
	function walkCampaigns(root, now, reuse) {
		const content = findContent(root);
		const result = { found: Boolean(content), recognized: false, campaigns: [], sections: [], diagnostics: emptyDiagnostics() };
		if (!content) return result;
		const diagnostics = result.diagnostics;
		const seenIds = new Set();
		let currentType = null;
		// querySelectorAll returns document order, so each header follows its section's <h4>.
		for (const node of content.querySelectorAll(`h4, ${HEADER_SELECTOR}`)) {
			if (node.tagName === 'H4') {
				const heading = textOf(node);
				currentType = SECTION_TYPES[normalize(heading)] || null;
				if (currentType) {
					result.recognized = true;
					result.sections.push({ type: currentType, heading: node });
				} else {
					diagnostics.unknownHeadings.push(heading);
				}
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
			rewardsSource: details && details.rewards ? 'page' : null,
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
		const leafTexts = [...body.querySelectorAll('div, span, p')]
			.filter((node) => !node.children.length && !node.closest('[data-tres]'))
			.map(textOf);
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
			return { name, type, imageUuid: imageUuidOf(src), closedMark, tileEl: tile };
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

	/**
	 * Reads the Inventory page (spec §11.1–11.2). Returns { found, ready, snapshot, loadMore, diagnostics }.
	 * `ready` is false until the Claimed list has rendered, so a half-loaded page is never saved.
	 * `windowOf(img, timeText)` may supply a claim's time window; by default it is measured from `now`.
	 */
	function extractInventory(root, now, windowOf) {
		const content = findContent(root);
		const page = content && content.querySelector('.inventory-page');
		const diagnostics = { groups: 0, rewards: 0, claims: 0, unknownTimes: [] };
		const result = { found: Boolean(page), ready: false, snapshot: null, loadMore: null, diagnostics };
		if (!page) return result;
		result.ready = [...page.querySelectorAll('h5')].some((heading) => textOf(heading) === 'Claimed');
		const inProgress = [...page.querySelectorAll('.inventory-campaign-info')].map((info) => readGroup(info, page));
		const claims = [];
		for (const img of page.querySelectorAll(CLAIM_IMAGE_SELECTOR)) {
			const claim = readClaim(img, page);
			const span = claim.timeText === null ? null : windowOf ? windowOf(img, claim.timeText) : relativeWindow(claim.timeText, now);
			if (!span) diagnostics.unknownTimes.push(claim.timeText);
			claims.push({ ...claim, earliest: span ? span.earliest : null, latest: span ? span.latest : null });
		}
		result.loadMore = findLoadMore(page);
		diagnostics.groups = inProgress.length;
		diagnostics.rewards = inProgress.reduce((sum, group) => sum + group.rewards.length, 0);
		diagnostics.claims = claims.length;
		result.snapshot = { schema: INVENTORY_SCHEMA, readAt: now, complete: !result.loadMore, inProgress, claims };
		return result;
	}

	/** One In Progress drop group: its title, drop id, end date and rewards. */
	function readGroup(info, page) {
		const link = info.querySelector('a[href*="dropID="]');
		const endLine = [...info.querySelectorAll('p')].map(textOf).find((text) => text.startsWith('End Date:'));
		// The group's container is the nearest ancestor that also holds reward images.
		let group = info.parentElement;
		while (group && group !== page && !group.querySelector(REWARD_IMAGE_SELECTOR)) group = group.parentElement;
		const isOwn = group && group !== page && group.querySelectorAll('.inventory-campaign-info').length === 1;
		return {
			dropId: (link?.getAttribute('href').match(/dropID=([0-9a-f-]+)/i)?.[1] || '').toLowerCase() || null,
			title: textOf(link),
			endText: endLine ? clean(endLine.slice('End Date:'.length)) : null,
			rewards: isOwn ? [...group.querySelectorAll(REWARD_IMAGE_SELECTOR)].map((img) => readProgress(img, group)) : []
		};
	}

	/** One In Progress reward. Its container is the nearest ancestor of the image that holds a progress bar. */
	function readProgress(img, group) {
		let container = img.parentElement;
		while (container !== group && !container.querySelector('[role="progressbar"]')) container = container.parentElement;
		const texts = [...container.querySelectorAll('p')].map(textOf).filter(Boolean);
		const caption = texts.find((text) => CAPTION_RE.test(text));
		const bar = container.querySelector('[role="progressbar"]');
		const percent = Number(bar ? bar.getAttribute('aria-valuenow') : caption ? caption.match(CAPTION_RE)[1] : 0) || 0;
		const labels = [...container.querySelectorAll('button, a')].map(textOf);
		let state = 'progress';
		if (labels.includes(CLAIM_NOW_TEXT)) state = 'claimable';
		else if (percent >= 100) state = labels.includes(CONNECT_TEXT) ? 'connect' : 'complete';
		return {
			name: texts.find((text) => !CAPTION_RE.test(text)) || '',
			imageUuid: imageUuidOf(img.getAttribute('src')),
			percent,
			requiredText: caption ? caption.match(CAPTION_RE)[2] : null,
			state
		};
	}

	/** One Claimed entry: the name from the image's alt text, and the relative time beside it. */
	function readClaim(img, page) {
		const name = clean(img.getAttribute('alt').slice(CLAIM_ALT_PREFIX.length));
		let timeText = null;
		for (let node = img.parentElement; node && node !== page && timeText === null; node = node.parentElement) {
			// Stop before climbing into a container that holds other entries.
			if (node.querySelectorAll(CLAIM_IMAGE_SELECTOR).length > 1) break;
			timeText = [...node.querySelectorAll('p')].map(textOf).find((text) => text && text !== name) ?? null;
		}
		return { name, imageUuid: imageUuidOf(img.getAttribute('src')), timeText };
	}

	function findLoadMore(page) {
		return [...page.querySelectorAll('button')].find((node) => textOf(node) === LOAD_MORE_TEXT) || null;
	}

	/** Aggregate counts for the diagnostics subpanel (spec §7). */
	function summarize(result) {
		const campaigns = result.campaigns;
		const groups = { open: campaigns.filter((c) => c.type !== CLOSED_TYPE), closed: campaigns.filter((c) => c.type === CLOSED_TYPE) };
		const byType = {};
		const tilesByType = {};
		let rewardsKnown = 0;
		let rewardsStored = 0;
		let unreadable = 0;
		let watermarks = 0;
		for (const campaign of campaigns) {
			byType[campaign.type] = (byType[campaign.type] || 0) + 1;
			if (campaign.rewards) rewardsKnown += 1;
			if (campaign.rewardsSource === 'stored') rewardsStored += 1;
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
			rewardsStored,
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
	// 4. Filter model and storage
	// =====================================================================

	function defaultData() {
		return {
			schema: SCHEMA,
			lastExportAt: null,
			rules: {
				hideClosed: true,
				hideUpcoming: false,
				showHidden: false,
				sortBy: SORT_KEYS[0],
				hiddenRewardTypes: [],
				hiddenCampaigns: {},
				hiddenGames: {},
				hiddenPublishers: {}
			},
			claimed: {},
			// { rewardKey: { at, campaignId } }: "not claimed, whatever the Inventory says" (spec §11.4).
			inventoryOverrides: {},
			campaigns: {}
		};
	}

	/** Coerces anything (missing, corrupt, older) into valid stored data. Never throws. */
	function sanitizeData(raw) {
		const base = defaultData();
		let value = raw;
		if (typeof value === 'string') {
			try {
				value = JSON.parse(value);
			} catch (error) {
				return base;
			}
		}
		if (!isPlainObject(value) || value.schema !== SCHEMA) return base;
		const rules = isPlainObject(value.rules) ? value.rules : {};
		const bool = (name) => (typeof rules[name] === 'boolean' ? rules[name] : base.rules[name]);
		const map = (input) => (isPlainObject(input) ? clone(input) : {});
		return {
			schema: SCHEMA,
			lastExportAt: typeof value.lastExportAt === 'number' ? value.lastExportAt : null,
			rules: {
				hideClosed: bool('hideClosed'),
				hideUpcoming: bool('hideUpcoming'),
				showHidden: bool('showHidden'),
				sortBy: SORT_KEYS.includes(rules.sortBy) ? rules.sortBy : base.rules.sortBy,
				hiddenRewardTypes: Array.isArray(rules.hiddenRewardTypes)
					? [...new Set(rules.hiddenRewardTypes.filter((type) => typeof type === 'string').map(normalize))]
					: [],
				hiddenCampaigns: map(rules.hiddenCampaigns),
				hiddenGames: map(rules.hiddenGames),
				hiddenPublishers: map(rules.hiddenPublishers)
			},
			claimed: map(value.claimed),
			inventoryOverrides: map(value.inventoryOverrides),
			campaigns: map(value.campaigns)
		};
	}

	/** Coerces a stored Inventory snapshot (spec §11.2) into a valid one, or null. Never throws. */
	function sanitizeInventory(raw) {
		let value = raw;
		if (typeof value === 'string') {
			try {
				value = JSON.parse(value);
			} catch (error) {
				return null;
			}
		}
		if (!isPlainObject(value) || value.schema !== INVENTORY_SCHEMA || typeof value.readAt !== 'number') return null;
		if (!Array.isArray(value.inProgress) || !Array.isArray(value.claims)) return null;
		const text = (input) => (typeof input === 'string' ? input : null);
		const time = (input) => (typeof input === 'number' ? input : null);
		return {
			schema: INVENTORY_SCHEMA,
			readAt: value.readAt,
			complete: value.complete === true,
			inProgress: value.inProgress.filter(isPlainObject).map((group) => ({
				dropId: text(group.dropId),
				title: text(group.title) || '',
				endText: text(group.endText),
				rewards: (Array.isArray(group.rewards) ? group.rewards : []).filter(isPlainObject).map((reward) => ({
					name: text(reward.name) || '',
					imageUuid: text(reward.imageUuid),
					percent: typeof reward.percent === 'number' ? reward.percent : 0,
					requiredText: text(reward.requiredText),
					state: ['progress', 'connect', 'claimable', 'complete'].includes(reward.state) ? reward.state : 'progress'
				}))
			})),
			claims: value.claims.filter(isPlainObject).map((claim) => ({
				name: text(claim.name) || '',
				imageUuid: text(claim.imageUuid),
				timeText: text(claim.timeText),
				earliest: time(claim.earliest),
				latest: time(claim.latest)
			}))
		};
	}

	function loadData(storage) {
		try {
			return sanitizeData(storage.read());
		} catch (error) {
			console.warn(LOG_PREFIX, 'could not read stored data; using defaults', error);
			return defaultData();
		}
	}

	/**
	 * Merges an imported backup into current data (spec §5): hide rules and claimed marks
	 * are unioned, toggles come from the backup, and for stored campaigns the newer
	 * rewardsSeenAt wins.
	 */
	function mergeImport(current, imported) {
		const a = sanitizeData(clone(current));
		const b = sanitizeData(imported);
		const merged = clone(a);
		merged.lastExportAt = Math.max(a.lastExportAt || 0, b.lastExportAt || 0) || null;
		for (const name of ['hideClosed', 'hideUpcoming', 'showHidden', 'sortBy']) merged.rules[name] = b.rules[name];
		merged.rules.hiddenRewardTypes = [...new Set([...a.rules.hiddenRewardTypes, ...b.rules.hiddenRewardTypes])];
		for (const name of ['hiddenCampaigns', 'hiddenGames', 'hiddenPublishers']) {
			merged.rules[name] = { ...a.rules[name], ...b.rules[name] };
		}
		merged.claimed = { ...a.claimed, ...b.claimed };
		merged.inventoryOverrides = { ...a.inventoryOverrides, ...b.inventoryOverrides };
		for (const [id, incoming] of Object.entries(b.campaigns)) {
			const existing = a.campaigns[id];
			if (!existing) {
				merged.campaigns[id] = incoming;
				continue;
			}
			const newer = (incoming.rewardsSeenAt || 0) > (existing.rewardsSeenAt || 0) ? incoming : existing;
			merged.campaigns[id] = {
				...newer,
				firstSeen: Math.min(existing.firstSeen || Infinity, incoming.firstSeen || Infinity),
				lastSeen: Math.max(existing.lastSeen || 0, incoming.lastSeen || 0)
			};
		}
		return merged;
	}

	/** Drops stored campaigns that ended and haven't been seen for 60 days, with their claimed marks. Never touches rules. */
	function prune(data, now) {
		const cutoff = now - PRUNE_AFTER_MS;
		const removed = new Set();
		for (const [id, entry] of Object.entries(data.campaigns)) {
			if (entry.end && entry.end < cutoff && (entry.lastSeen || 0) < cutoff) {
				delete data.campaigns[id];
				removed.add(id);
			}
		}
		for (const map of [data.claimed, data.inventoryOverrides]) {
			for (const [key, entry] of Object.entries(map)) if (removed.has(entry.campaignId)) delete map[key];
		}
		return removed.size;
	}

	/**
	 * Saves what the page shows about each campaign, and fills in what it doesn't from
	 * storage (spec §4.5): rewards learned once are reused after reloads. Returns true
	 * if `data` changed and should be written.
	 */
	function learnCampaigns(campaigns, data, now) {
		let changed = false;
		for (const campaign of campaigns) {
			let entry = data.campaigns[campaign.id];
			if (!entry) {
				entry = data.campaigns[campaign.id] = {
					firstSeen: now, lastSeen: now, end: campaign.end, title: null, redeem: null, connection: null, rewardsSeenAt: null, rewards: null
				};
				changed = true;
			} else if (now - (entry.lastSeen || 0) > LAST_SEEN_RESOLUTION_MS) {
				entry.lastSeen = now;
				changed = true;
			}
			if (campaign.bodyLoaded) {
				for (const field of ['title', 'redeem', 'connection']) {
					if (JSON.stringify(campaign[field]) !== JSON.stringify(entry[field])) {
						entry[field] = campaign[field];
						changed = true;
					}
				}
				if (campaign.rewardsSource === 'page') {
					const rewards = campaign.rewards.map(({ key, name, type, imageUuid }) => ({ key, name, type, imageUuid }));
					if (JSON.stringify(rewards) !== JSON.stringify(entry.rewards)) {
						entry.rewards = rewards;
						entry.rewardsSeenAt = now;
						changed = true;
					}
				}
			} else {
				for (const field of ['title', 'redeem', 'connection']) if (campaign[field] === null) campaign[field] = entry[field] ?? null;
			}
			if (!campaign.rewards && entry.rewards) {
				campaign.rewards = entry.rewards.map((reward) => ({ ...reward, closedMark: false, tileEl: null }));
				campaign.rewardsSource = 'stored';
			}
		}
		return changed;
	}

	/**
	 * Matches an Inventory snapshot to the campaigns (spec §11.3). Pure. Returns
	 * { claimedKeys: Set, progressByKey: Map, matched, unmatched }. Conservative: a claim counts
	 * only when exactly one campaign reward has its image and a [start, end] containing its window.
	 */
	function matchInventory(campaigns, inventory) {
		const result = {
			claimedKeys: new Set(),
			progressByKey: new Map(),
			matched: { claims: 0, groups: 0, progress: 0 },
			unmatched: { claims: 0, ambiguous: 0, noTime: 0, groups: 0 }
		};
		if (!inventory) return result;
		const known = campaigns.filter((campaign) => campaign.rewards && campaign.rewards.length);
		const hasImage = (campaign, uuid) => campaign.rewards.some((reward) => reward.imageUuid === uuid);

		for (const group of inventory.inProgress) {
			const uuids = [...new Set(group.rewards.map((reward) => reward.imageUuid).filter(Boolean))];
			let candidates = uuids.length
				? known.filter((campaign) => campaign.title && normalize(campaign.title) === normalize(group.title) && uuids.some((uuid) => hasImage(campaign, uuid)))
				: [];
			if (uuids.length && candidates.length !== 1) candidates = known.filter((campaign) => uuids.every((uuid) => hasImage(campaign, uuid)));
			if (candidates.length !== 1) {
				result.unmatched.groups += 1;
				continue;
			}
			result.matched.groups += 1;
			for (const progress of group.rewards) {
				if (!progress.imageUuid) continue;
				let targets = candidates[0].rewards.filter((reward) => reward.imageUuid === progress.imageUuid);
				// The same image twice in one campaign: tell them apart by name, or not at all.
				if (targets.length > 1) targets = targets.filter((reward) => normalize(reward.name) === normalize(progress.name));
				if (targets.length !== 1) continue;
				result.progressByKey.set(targets[0].key, { percent: progress.percent, requiredText: progress.requiredText, state: progress.state });
				result.matched.progress += 1;
			}
		}

		for (const claim of inventory.claims) {
			if (!claim.imageUuid || claim.earliest === null || claim.latest === null) {
				result.unmatched.noTime += 1;
				continue;
			}
			const hits = [];
			for (const campaign of known) {
				if (campaign.start === null || campaign.end === null || claim.earliest < campaign.start || claim.latest > campaign.end) continue;
				for (const reward of campaign.rewards) if (reward.imageUuid === claim.imageUuid) hits.push(reward.key);
			}
			if (hits.length === 1) {
				result.claimedKeys.add(hits[0]);
				result.matched.claims += 1;
			} else {
				result.unmatched[hits.length ? 'ambiguous' : 'claims'] += 1;
			}
		}
		return result;
	}

	/**
	 * The claimed marks the rules use (spec §11.4): manual ticks, plus Inventory claims the user
	 * hasn't overridden. Inventory entries carry `source: 'inventory'`.
	 */
	function effectiveClaims(data, match) {
		const claimed = { ...data.claimed };
		for (const key of match.claimedKeys) {
			if (!claimed[key] && !data.inventoryOverrides[key]) claimed[key] = { source: 'inventory' };
		}
		return claimed;
	}

	function rewardDone(reward, rules, claimed) {
		return Boolean(claimed[reward.key]) || rules.hiddenRewardTypes.includes(normalize(reward.type));
	}

	/** Why a campaign is hidden (a REASON_LABELS key), or null if it's visible. Any rule hides (spec §4.1). */
	function hideReason(campaign, rules, claimed) {
		if (rules.hiddenCampaigns[campaign.id]) return 'campaign';
		if (rules.hiddenGames[campaign.gameKey]) return 'game';
		if (rules.hiddenPublishers[campaign.publisherKey]) return 'publisher';
		if (rules.hideClosed && campaign.closed) return 'closed';
		if (rules.hideUpcoming && campaign.status === 'upcoming') return 'upcoming';
		if (campaign.rewards && campaign.rewards.length && campaign.rewards.every((reward) => rewardDone(reward, rules, claimed))) return 'rewards';
		return null;
	}

	/**
	 * Campaigns in display order for a sort option (spec §4.6). Stable: ties keep Twitch's
	 * order, and campaigns without parsed dates go after dated ones.
	 */
	function sortCampaigns(campaigns, sortBy) {
		const byText = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
		const byTime = (field, direction) => (a, b) => {
			if (a[field] === null || b[field] === null) return (a[field] === null) - (b[field] === null);
			return direction * (a[field] - b[field]);
		};
		const compare = {
			newest: byTime('start', -1),
			ending: byTime('end', 1),
			game: (a, b) => byText(a.game, b.game) || byText(a.publisher, b.publisher),
			publisher: (a, b) => byText(a.publisher, b.publisher) || byText(a.game, b.game)
		}[sortBy];
		const indexed = campaigns.map((campaign, index) => ({ campaign, index }));
		if (compare) indexed.sort((a, b) => compare(a.campaign, b.campaign) || a.index - b.index);
		return indexed.map(({ campaign }) => campaign);
	}

	/**
	 * Final display order within a section (spec §4.6): visibility first, then the sort option.
	 * Visible campaigns come first and dimmed ones last, each group in `sortBy` order.
	 */
	function displayOrder(campaigns, sortBy, isDimmed) {
		const visible = campaigns.filter((campaign) => !isDimmed(campaign));
		const dimmed = campaigns.filter((campaign) => isDimmed(campaign));
		return [...sortCampaigns(visible, sortBy), ...sortCampaigns(dimmed, sortBy)];
	}

	/**
	 * Settings live under STORAGE_KEY; the Inventory snapshot under INVENTORY_KEY, so the
	 * Inventory and Campaigns tabs never overwrite each other's data (spec §11.6).
	 * `watchInventory(callback)` reports snapshot changes from any tab and returns an unsubscribe.
	 */
	function gmStorage() {
		return {
			read: () => GM_getValue(STORAGE_KEY, null),
			write: (value) => GM_setValue(STORAGE_KEY, value),
			readInventory: () => GM_getValue(INVENTORY_KEY, null),
			writeInventory: (value) => GM_setValue(INVENTORY_KEY, value),
			watchInventory(callback) {
				if (typeof GM_addValueChangeListener !== 'function') return () => {};
				const id = GM_addValueChangeListener(INVENTORY_KEY, () => callback());
				return () => { if (typeof GM_removeValueChangeListener === 'function') GM_removeValueChangeListener(id); };
			}
		};
	}

	/** In-memory storage for tests. Two windows sharing one behave like two tabs. */
	function memoryStorage(initial = null, initialInventory = null) {
		let value = initial === null ? null : clone(initial);
		let inventory = initialInventory === null ? null : clone(initialInventory);
		const watchers = new Set();
		return {
			read: () => (value === null ? null : clone(value)),
			write: (next) => { value = clone(next); },
			readInventory: () => (inventory === null ? null : clone(inventory)),
			writeInventory(next) {
				inventory = next === null ? null : clone(next);
				for (const callback of [...watchers]) callback();
			},
			watchInventory(callback) {
				watchers.add(callback);
				return () => watchers.delete(callback);
			}
		};
	}

	// =====================================================================
	// 5. Rendering
	// =====================================================================

	const PANEL_CSS = `
#tres-panel{position:fixed;top:calc(5rem + 8px);right:16px;z-index:1000;font:13px/1.4 Inter,Roobert,'Helvetica Neue',Helvetica,Arial,sans-serif;color:#efeff1}
#tres-panel *,#tres-menu *{box-sizing:border-box}
#tres-panel .tres-pill{display:block;margin-left:auto;padding:4px 10px;border:1px solid ${BRAND_COLOR};border-radius:999px;background:#18181b;color:#efeff1;font:inherit;font-weight:600;cursor:pointer;opacity:.85}
#tres-panel .tres-pill:hover{opacity:1}
#tres-panel .tres-body{width:min(380px,calc(100vw - 32px));max-height:calc(100vh - 7rem);overflow:auto;padding:12px;border:1px solid ${BRAND_COLOR};border-radius:6px;background:#18181b;box-shadow:0 8px 24px rgba(0,0,0,.5)}
#tres-panel[data-expanded="false"] .tres-body{display:none}
#tres-panel[data-expanded="true"] .tres-pill{display:none}
#tres-panel .tres-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
#tres-panel .tres-head strong{font-size:14px}
#tres-panel button.tres-btn{padding:3px 8px;border:0;border-radius:4px;background:#3d3d42;color:#efeff1;font:inherit;cursor:pointer}
#tres-panel button.tres-btn:hover{background:#53535f}
#tres-panel .tres-warning{margin:0 0 8px;padding:8px;border-radius:4px;background:#5c1a1a;color:#ffd4d4}
#tres-panel .tres-summary{margin:0 0 8px;color:#bf94ff;font-weight:600}
#tres-panel .tres-section{margin-top:10px;padding-top:8px;border-top:1px solid #3d3d42}
#tres-panel summary{margin:0 0 4px;font-size:13px;font-weight:600;cursor:pointer}
#tres-panel label{display:flex;gap:6px;align-items:baseline;margin:2px 0;cursor:pointer;overflow-wrap:anywhere}
#tres-panel label.tres-major{font-weight:600}
#tres-panel .tres-count{margin-left:auto;padding-left:6px;color:#adadb8;white-space:nowrap}
#tres-panel .tres-note{margin:2px 0;color:#adadb8}
#tres-panel .tres-list{margin:6px 0}
#tres-panel .tres-list h4{margin:6px 0 2px;font-size:12px;color:#adadb8}
#tres-panel input[type="search"]{width:100%;margin:2px 0 4px;padding:3px 6px;border:1px solid #3d3d42;border-radius:4px;background:#0e0e10;color:#efeff1;font:inherit}
#tres-panel .tres-options{max-height:160px;overflow:auto;margin:0;padding:2px 6px;list-style:none;border:1px solid #3d3d42;border-radius:4px;background:#0e0e10}
#tres-panel .tres-options:empty::before{content:'None';color:#adadb8}
#tres-panel .tres-hidden-list li{display:flex;gap:6px;align-items:baseline;margin:2px 0}
#tres-panel .tres-hidden-list span{flex:1;overflow-wrap:anywhere}
#tres-panel .tres-row{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0}
#tres-panel .tres-diag{margin:6px 0;padding:0;list-style:none;color:#adadb8}
#tres-panel .tres-diag li{margin:2px 0;overflow-wrap:anywhere}
#tres-panel .tres-diag .tres-bad{color:#ff8280}
#tres-panel .tres-status{min-height:1em;margin:4px 0 0;color:#adadb8}
.drops-root__content .tres-sorted{display:flex!important;flex-direction:column}
.drops-root__content .tres-hidden{display:none!important}
.drops-root__content .tres-dimmed{opacity:.4}
.drops-root__content .tres-dimmed:hover{opacity:.75}
.drops-root__content .accordion-header{position:relative}
.drops-root__content .tres-controls{position:absolute;top:3px;right:3px;display:flex;gap:4px;align-items:center;z-index:1;line-height:16px}
.drops-root__content .tres-reason{padding:0 6px;border:1px solid ${BRAND_COLOR};border-radius:999px;background:#5c1a1a;color:#ffd4d4;font-size:11px}
.drops-root__content .tres-hide-btn,.drops-root__content .tres-more-btn{padding:0 8px;border:1px solid ${BRAND_COLOR};border-radius:999px;background:#18181b;color:#efeff1;font-size:11px;line-height:16px;cursor:pointer;opacity:.6}
.drops-root__content .tres-hide-btn:hover,.drops-root__content .tres-more-btn:hover{opacity:1}
.drops-root__content .drop-benefit__image-container{position:relative}
.drops-root__content .tres-claim{position:absolute;top:2px;right:2px;display:flex;gap:3px;align-items:center;padding:1px 6px;border:1px solid ${BRAND_COLOR};border-radius:999px;background:rgba(14,14,16,.85);color:#efeff1;font-size:11px;cursor:pointer;z-index:1}
.drops-root__content .tres-claim input{margin:0}
.drops-root__content [data-tres-done]{opacity:.45}
.drops-root__content .tres-done-reason{position:absolute;bottom:2px;left:2px;padding:0 6px;border:1px solid ${BRAND_COLOR};border-radius:999px;background:rgba(14,14,16,.85);color:#adadb8;font-size:11px}
.drops-root__content .tres-progress{position:absolute;left:0;right:0;bottom:0;height:4px;background:rgba(14,14,16,.7);z-index:1}
.drops-root__content .tres-progress>div{height:100%;background:#9147ff}
.drops-root__content .tres-progress-pill{position:absolute;bottom:6px;left:2px;max-width:calc(100% - 4px);padding:0 6px;border:1px solid ${BRAND_COLOR};border-radius:999px;background:rgba(14,14,16,.85);color:#efeff1;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;z-index:1}
.drops-root__content [data-tres-in-progress] img{opacity:.6}
.drops-root__content .tres-header-progress{padding:0 6px;border:1px solid ${BRAND_COLOR};border-radius:999px;background:#18181b;color:#efeff1;font-size:11px;white-space:nowrap}
.drops-root__content h4.tres-counted{display:inline-block}
.drops-root__content .tres-section-count{display:inline-block;margin-left:8px;padding:0 8px;border:1px solid ${BRAND_COLOR};border-radius:999px;background:transparent;color:#adadb8;font-family:inherit;font-size:12px;line-height:18px;vertical-align:middle}
.drops-root__content button.tres-section-count{cursor:pointer}
.drops-root__content button.tres-section-count:hover{color:#efeff1}
#tres-menu{position:fixed;z-index:1001;min-width:200px;padding:4px;border:1px solid ${BRAND_COLOR};border-radius:6px;background:#18181b;box-shadow:0 8px 24px rgba(0,0,0,.5);font:13px/1.4 Inter,Roobert,'Helvetica Neue',Helvetica,Arial,sans-serif}
#tres-menu button{display:block;width:100%;padding:5px 8px;border:0;border-radius:4px;background:none;color:#efeff1;font:inherit;text-align:left;cursor:pointer}
#tres-menu button:hover{background:#3d3d42}
`;

	function element(doc, tag, className, text) {
		const node = doc.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function checkboxLabel(doc, text, className) {
		const label = element(doc, 'label', className);
		const input = element(doc, 'input');
		input.type = 'checkbox';
		const span = element(doc, 'span', '', text);
		const count = element(doc, 'span', 'tres-count');
		label.append(input, span, count);
		return { label, input, span, count };
	}

	function isTextInputFocused(doc, container) {
		const active = doc.activeElement;
		return Boolean(active && container.contains(active) && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && !/^(checkbox|radio|button|file)$/.test(active.type))));
	}

	/**
	 * A checkbox list. Rebuilt only when its keys, labels or counts change; otherwise
	 * just the checked states are synced, so scroll position and focus survive.
	 */
	function createCheckList(doc, { title, searchable, onToggle }) {
		const wrap = element(doc, 'div', 'tres-list');
		if (title) wrap.append(element(doc, 'h4', '', title));
		let search = null;
		if (searchable) {
			search = element(doc, 'input');
			search.type = 'search';
			search.placeholder = `Filter ${title ? title.toLowerCase() : ''}…`;
			wrap.append(search);
		}
		const list = element(doc, 'ul', 'tres-options');
		wrap.append(list);
		let signature = '';

		const applySearch = () => {
			const query = normalize(search ? search.value : '');
			for (const item of list.children) item.hidden = Boolean(query) && !item.dataset.search.includes(query);
		};
		if (search) search.addEventListener('input', applySearch);
		list.addEventListener('change', (event) => {
			if (event.target.matches('input[type="checkbox"]')) onToggle(event.target.value, event.target.checked);
		});

		return {
			element: wrap,
			update(items) {
				const nextSignature = JSON.stringify(items.map((item) => [item.key, item.label, item.count]));
				if (nextSignature !== signature) {
					signature = nextSignature;
					const scrollTop = list.scrollTop;
					list.replaceChildren(...items.map((item) => {
						const row = element(doc, 'li');
						const { label, input, count } = checkboxLabel(doc, item.label);
						input.value = item.key;
						count.textContent = item.count;
						row.dataset.search = normalize(item.label);
						row.append(label);
						return row;
					}));
					list.scrollTop = scrollTop;
					applySearch();
				}
				const checked = new Map(items.map((item) => [item.key, item.checked]));
				for (const input of list.querySelectorAll('input[type="checkbox"]')) input.checked = Boolean(checked.get(input.value));
			}
		};
	}

	/**
	 * The floating panel's frame, shared by the Campaigns and Inventory pages (spec §4.3, §11.5):
	 * the style sheet, a collapsed pill, and a body that only "–" or Esc collapses.
	 */
	function createShell(doc, win, title, page) {
		const style = element(doc, 'style');
		style.id = 'tres-style';
		style.setAttribute('data-tres', 'style');
		style.textContent = PANEL_CSS;
		doc.head.appendChild(style);

		const panel = element(doc, 'div');
		panel.id = 'tres-panel';
		panel.setAttribute('data-tres', 'panel');
		panel.dataset.expanded = 'false';
		panel.dataset.page = page;

		const pill = element(doc, 'button', 'tres-pill', 'TRES');
		pill.type = 'button';
		pill.title = title;

		const body = element(doc, 'div', 'tres-body');
		const head = element(doc, 'div', 'tres-head');
		const collapse = button(doc, '–', () => setExpanded(false));
		collapse.title = 'Collapse';
		head.append(element(doc, 'strong', '', title), collapse);
		body.append(head);
		panel.append(pill, body);
		doc.body.appendChild(panel);

		function setExpanded(expanded) {
			panel.dataset.expanded = String(expanded);
		}
		pill.addEventListener('click', () => setExpanded(true));
		// Clicks outside the panel never collapse it (spec §4.3); only "–" or Esc does.
		const onKeyDown = (event) => {
			if (event.key === 'Escape' && panel.dataset.expanded === 'true') setExpanded(false);
		};
		doc.addEventListener('keydown', onKeyDown, true);

		return {
			panel,
			pill,
			body,
			setExpanded,
			destroy() {
				doc.removeEventListener('keydown', onKeyDown, true);
				panel.remove();
				style.remove();
			}
		};
	}

	function createPanel(doc, win, actions) {
		const { panel, pill, body, setExpanded, destroy } = createShell(doc, win, 'Drop campaign filters', 'campaigns');

		const warning = element(doc, 'p', 'tres-warning', 'Unrecognised page. Is Twitch set to English?');
		warning.hidden = true;
		const summary = element(doc, 'p', 'tres-summary');

		// Visibility toggles
		const hideClosed = checkboxLabel(doc, 'Hide closed campaigns', 'tres-major');
		const hideUpcoming = checkboxLabel(doc, 'Hide upcoming campaigns');
		const showHidden = checkboxLabel(doc, 'Show hidden campaigns (dimmed)');
		hideClosed.input.addEventListener('change', () => actions.setRule('hideClosed', hideClosed.input.checked));
		hideUpcoming.input.addEventListener('change', () => actions.setRule('hideUpcoming', hideUpcoming.input.checked));
		showHidden.input.addEventListener('change', () => actions.setRule('showHidden', showHidden.input.checked));
		const visibility = section(doc, 'Visibility', false, hideClosed.label, hideUpcoming.label, showHidden.label);

		// Sorting (spec §4.6)
		const sortInputs = SORT_OPTIONS.map(([key, text]) => {
			const label = element(doc, 'label');
			const input = element(doc, 'input');
			input.type = 'radio';
			input.name = 'tres-sort';
			input.value = key;
			input.addEventListener('change', () => { if (input.checked) actions.setRule('sortBy', key); });
			label.append(input, element(doc, 'span', '', text));
			return { label, input };
		});
		const sorting = section(doc, 'Sorting', false, ...sortInputs.map(({ label }) => label));

		// Rewards
		const rewardsKnown = element(doc, 'p', 'tres-note');
		const rewardTypes = createCheckList(doc, { title: 'Hide reward types', onToggle: (key, hide) => actions.setRewardType(key, hide) });
		const rewardsNote = element(doc, 'p', 'tres-note', 'A campaign hides when every reward is claimed or of a hidden type.');
		const loadButton = button(doc, 'Load all rewards', () => actions.loadRewards('unknown'));
		loadButton.title = 'Open each campaign whose rewards are unknown, one at a time, and remember its rewards';
		const rereadButton = button(doc, 'Re-read all rewards', () => actions.loadRewards('all'));
		rereadButton.title = 'Open every campaign again to pick up rewards Twitch has changed';
		const cancelButton = button(doc, 'Cancel', () => actions.cancelLoad());
		const loaderRow = element(doc, 'div', 'tres-row');
		loaderRow.append(loadButton, rereadButton, cancelButton);
		const loaderStatus = element(doc, 'p', 'tres-status');
		const rewards = section(doc, 'Rewards', false, rewardsKnown, loaderRow, loaderStatus, rewardTypes.element, rewardsNote);

		// Open / Closed groups. Hide rules apply everywhere, so both groups show the same state.
		const makeGroup = (name, open) => {
			const publishers = createCheckList(doc, { title: 'Publishers', searchable: true, onToggle: (key, hide) => actions.setPublisher(key, hide) });
			const games = createCheckList(doc, { title: 'Games', searchable: true, onToggle: (key, hide) => actions.setGame(key, hide) });
			const details = section(doc, name, open, publishers.element, games.element);
			return { element: details, summary: details.firstElementChild, publishers, games };
		};
		const openGroup = makeGroup('Open campaigns', false);
		const closedGroup = makeGroup('Closed campaigns', false);

		// Hidden campaigns
		const hiddenList = element(doc, 'ul', 'tres-options tres-hidden-list');
		const hiddenSection = section(doc, 'Hidden campaigns', false, hiddenList);
		hiddenList.addEventListener('click', (event) => {
			const target = event.target.closest('button[data-id]');
			if (target) actions.unhideCampaign(target.dataset.id);
		});

		// Claimed rewards
		const claimedLine = element(doc, 'p', 'tres-note');
		const clearClaims = button(doc, 'Clear marks for campaigns no longer listed', () => actions.clearOrphanClaims());
		const claimedSection = section(doc, 'Claimed rewards', false, claimedLine, clearClaims);

		// Inventory (spec §11.5)
		const inventoryLine = element(doc, 'p', 'tres-note');
		const inventoryCounts = element(doc, 'p', 'tres-note');
		const inventoryStatus = element(doc, 'p', 'tres-status');
		const rescanButton = button(doc, 'Rescan on Inventory tab', () => actions.openInventory());
		rescanButton.title = 'Open the Inventory tab; TRES reads it on arrival';
		const clearInventoryButton = button(doc, 'Clear Inventory claims', () => setStatus(inventoryStatus, actions.clearInventory()));
		clearInventoryButton.title = 'Forget what was read from the Inventory. Manual ticks are kept.';
		const inventoryRow = element(doc, 'div', 'tres-row');
		inventoryRow.append(rescanButton, clearInventoryButton);
		const inventorySection = section(doc, 'Inventory', false, inventoryLine, inventoryCounts, inventoryRow, inventoryStatus);

		// Backup
		const backupLine = element(doc, 'p', 'tres-note');
		const fileInput = element(doc, 'input');
		fileInput.type = 'file';
		fileInput.accept = 'application/json,.json';
		fileInput.hidden = true;
		fileInput.addEventListener('change', async () => {
			const file = fileInput.files && fileInput.files[0];
			fileInput.value = '';
			if (file) setStatus(backupStatus, await actions.importFile(file));
		});
		const backupStatus = element(doc, 'p', 'tres-status');
		const backupRow = element(doc, 'div', 'tres-row');
		backupRow.append(
			button(doc, 'Export', () => setStatus(backupStatus, actions.exportData())),
			button(doc, 'Import', () => fileInput.click()),
			button(doc, 'Reset all', () => setStatus(backupStatus, actions.resetAll()))
		);
		const backupSection = section(doc, 'Backup', false, backupLine, backupRow, fileInput, backupStatus);

		// Diagnostics
		const diagList = element(doc, 'ul', 'tres-diag');
		const copyStatus = element(doc, 'p', 'tres-status');
		const copyButton = button(doc, 'Copy model as JSON', async () => {
			setStatus(copyStatus, (await actions.copyModel()) ? 'Copied.' : 'Copy failed; the model was logged to the console.');
		});
		const diagnostics = section(doc, 'Diagnostics', false, diagList, copyButton, copyStatus);

		const filters = [visibility, sorting, rewards, openGroup.element, closedGroup.element, hiddenSection, claimedSection, inventorySection, backupSection];
		body.append(warning, summary, ...filters, diagnostics);

		// Never rebuild while the user is typing in the panel; flush once focus leaves.
		let pendingView = null;
		panel.addEventListener('focusout', () => win.setTimeout(() => {
			if (pendingView && !isTextInputFocused(doc, panel)) render(pendingView);
		}, 0));

		const parts = new Map();
		function changed(name, value) {
			const signature = JSON.stringify(value);
			if (parts.get(name) === signature) return false;
			parts.set(name, signature);
			return true;
		}

		function render(view) {
			pendingView = null;
			const c = view.counts;
			const loader = view.loader;
			pill.textContent = !view.found ? 'TRES'
				: !view.recognized ? 'TRES · !'
					: loader.running ? `TRES · loading ${loader.done}/${loader.total}`
						: `TRES · ${c.hidden} hidden`;
			warning.hidden = view.recognized || !view.found;
			for (const node of filters) node.hidden = !view.recognized;
			summary.textContent = `${c.visible} shown · ${c.hidden} hidden · ${c.total} campaigns (${c.closed} closed)`;

			hideClosed.input.checked = view.rules.hideClosed;
			hideClosed.count.textContent = c.closed;
			hideUpcoming.input.checked = view.rules.hideUpcoming;
			hideUpcoming.count.textContent = c.upcoming;
			showHidden.input.checked = view.rules.showHidden;
			showHidden.count.textContent = c.hidden;
			for (const { input } of sortInputs) input.checked = input.value === view.rules.sortBy;

			rewardsKnown.textContent = `Rewards known for ${view.rewardsKnown} / ${c.total} campaigns.`;
			const unknown = c.total - view.rewardsKnown;
			loadButton.textContent = unknown ? `Load all rewards (${unknown})` : 'All rewards known';
			loadButton.disabled = loader.running || unknown === 0;
			rereadButton.textContent = `Re-read all rewards (${c.total})`;
			rereadButton.disabled = loader.running || c.total === 0;
			cancelButton.hidden = !loader.running;
			loaderStatus.textContent = loader.running
				? `Loading rewards ${loader.done} / ${loader.total}…`
				: loader.total
					? `${loader.cancelled ? 'Cancelled' : 'Finished'}: read ${loader.done} of ${loader.total}${loader.timeouts.length ? `, ${loader.timeouts.length} timed out` : ''}.`
					: '';
			rewardTypes.update(view.rewardTypes);
			for (const [group, data] of [[openGroup, view.groups.open], [closedGroup, view.groups.closed]]) {
				group.summary.textContent = `${group === openGroup ? 'Open' : 'Closed'} campaigns (${data.count})`;
				group.publishers.update(data.publishers);
				group.games.update(data.games);
			}
			if (changed('hidden', view.hiddenCampaigns)) {
				hiddenList.replaceChildren(...view.hiddenCampaigns.map((item) => {
					const row = element(doc, 'li');
					const unhide = element(doc, 'button', 'tres-btn', 'Unhide');
					unhide.type = 'button';
					unhide.dataset.id = item.id;
					row.append(element(doc, 'span', '', item.label), unhide);
					return row;
				}));
			}
			claimedLine.textContent = `${view.claimed.total} rewards marked claimed (${view.claimed.orphans} for campaigns no longer listed).`;
			clearClaims.disabled = view.claimed.orphans === 0;
			const inventory = view.inventory;
			inventoryLine.textContent = inventory.readAt === null
				? 'Not read yet. Open the Inventory tab once.'
				: `Inventory last read ${formatAge(view.now - inventory.readAt)} · ${inventory.complete ? 'complete history' : 'recent claims only'}.`;
			const unmatchedClaims = inventory.unmatched.claims + inventory.unmatched.ambiguous + inventory.unmatched.noTime;
			inventoryCounts.textContent = inventory.readAt === null ? ''
				: `${inventory.matched.claims} claims matched · ${inventory.matched.progress} rewards in progress · ${unmatchedClaims} claims unmatched (${inventory.unmatched.ambiguous} ambiguous) · ${inventory.unmatched.groups} In Progress groups unmatched.`;
			clearInventoryButton.disabled = inventory.readAt === null;
			backupLine.textContent = view.lastExportAt
				? `Last backup: ${Math.floor((view.now - view.lastExportAt) / DAY_MS)} days ago.`
				: 'No backup yet. Export saves your filters and claimed marks to a file.';
			if (changed('diag', [view.summary, view.lastScanAt, view.scanMs, loader.timeouts])) {
				diagList.replaceChildren(...diagnosticLines(view).map(([text, bad]) => element(doc, 'li', bad ? 'tres-bad' : '', text)));
			}
		}

		return {
			element: panel,
			isExpanded: () => panel.dataset.expanded === 'true',
			setExpanded,
			update(view) {
				if (isTextInputFocused(doc, panel)) pendingView = view;
				else render(view);
			},
			destroy
		};
	}

	/** The small panel on the Inventory page (spec §11.5): what was read, Scan full history, Clear and rescan, Diagnostics. */
	function createInventoryPanel(doc, win, actions) {
		const { panel, pill, body, setExpanded, destroy } = createShell(doc, win, 'TRES Inventory', 'inventory');
		const line = element(doc, 'p', 'tres-note');
		const counts = element(doc, 'p', 'tres-note');
		const status = element(doc, 'p', 'tres-status');
		const scanButton = button(doc, 'Scan full history (Load More)', () => actions.scanHistory());
		scanButton.title = 'Click Load More until the whole six-month history is listed';
		const cancelButton = button(doc, 'Cancel', () => actions.cancelScan());
		const clearButton = button(doc, 'Clear and rescan', () => setStatus(status, actions.clearAndRescan()));
		const row = element(doc, 'div', 'tres-row');
		row.append(scanButton, cancelButton, clearButton);
		const inventory = section(doc, 'Inventory', false, line, counts, row, status);
		const diagList = element(doc, 'ul', 'tres-diag');
		const diagnostics = section(doc, 'Diagnostics', false, diagList);
		body.append(inventory, diagnostics);

		return {
			element: panel,
			isExpanded: () => panel.dataset.expanded === 'true',
			setExpanded,
			update(view) {
				const snapshot = view.snapshot;
				const history = view.history;
				const inProgress = snapshot ? snapshot.inProgress.reduce((sum, group) => sum + group.rewards.length, 0) : 0;
				pill.textContent = !snapshot ? 'TRES'
					: history.running ? `TRES · loading history (${history.clicks})`
						: `TRES · ${snapshot.claims.length} claimed · ${inProgress} in progress`;
				line.textContent = !snapshot
					? 'The Inventory has not been read yet.'
					: `Read ${formatAge(view.now - snapshot.readAt)} · ${snapshot.complete ? 'complete history' : 'recent claims only'}.`;
				counts.textContent = snapshot ? `${snapshot.claims.length} claims · ${snapshot.inProgress.length} drops in progress (${inProgress} rewards).` : '';
				scanButton.disabled = history.running || !view.loadMore;
				cancelButton.hidden = !history.running;
				clearButton.disabled = history.running;
				if (history.running) setStatus(status, `Loading more… ${history.clicks} clicks so far.`);
				else if (history.finished) {
					setStatus(status, history.cancelled ? 'Cancelled.' : history.timedOut ? 'Stopped: Load More did not load anything new.' : 'Finished: the full history is read.');
				}
				const d = view.diagnostics;
				diagList.replaceChildren(...[
					[`In Progress groups read: ${d.groups} (${d.rewards} rewards)`],
					[`Claims read: ${d.claims}`],
					[`Unrecognised time strings: ${d.unknownTimes.length}${d.unknownTimes.length ? ` (${[...new Set(d.unknownTimes)].join(', ')})` : ''}`, d.unknownTimes.length > 0],
					[`Load More present: ${view.loadMore ? 'yes' : 'no'}`],
					[`Last read: ${view.lastReadAt || 'never'} (${view.readMs} ms)`],
					[view.found ? 'Inventory page found.' : 'Inventory page not found yet.', !view.found]
				].map(([text, bad]) => element(doc, 'li', bad ? 'tres-bad' : '', text)));
			},
			destroy
		};
	}

	/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
	function formatAge(ms) {
		const minutes = Math.floor(Math.max(0, ms) / MINUTE_MS);
		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
		const days = Math.floor(hours / 24);
		return `${days} day${days === 1 ? '' : 's'} ago`;
	}

	/** A collapsible panel section; `open` sets whether it starts expanded (all start collapsed, spec §4.3). */
	function section(doc, title, open, ...children) {
		const node = element(doc, 'details', 'tres-section');
		node.open = open;
		node.append(element(doc, 'summary', '', title), ...children);
		return node;
	}

	function button(doc, text, onClick) {
		const node = element(doc, 'button', 'tres-btn', text);
		node.type = 'button';
		node.addEventListener('click', onClick);
		return node;
	}

	function setStatus(node, text) {
		node.textContent = text || '';
	}

	function diagnosticLines(view) {
		const s = view.summary;
		const lines = [];
		lines.push([`Headers found: ${s.headers} · campaigns parsed: ${s.parsed}`, s.headers !== s.parsed]);
		if (s.unknownHeadings.length) lines.push([`Unrecognised headings: ${s.unknownHeadings.join(' | ')}`, true]);
		lines.push([`By section: ${Object.entries(s.byType).map(([type, count]) => `${type} ${count}`).join(' · ') || 'none'}`]);
		lines.push([`Games: ${s.games.open} open · ${s.games.closed} closed · ${s.games.all} total`]);
		lines.push([`Publishers: ${s.publishers.open} open · ${s.publishers.closed} closed · ${s.publishers.all} total`]);
		lines.push([`Rewards known for ${s.rewardsKnown} / ${s.parsed} campaigns (${s.rewardsStored} from storage)`]);
		lines.push([`Loaded bodies with unreadable rewards: ${s.unreadable}`, s.unreadable > 0]);
		lines.push([`Reward tiles by type: ${Object.entries(s.tilesByType).map(([type, count]) => `${type} ${count}`).join(' · ') || 'none yet'}`]);
		lines.push([`Tiles with closed watermark: ${s.watermarks}`]);
		lines.push([`Dates that failed to parse: ${s.dateFailures}`, s.dateFailures > 0]);
		lines.push([`Timezone label mismatches: ${s.tzMismatches}`, s.tzMismatches > 0]);
		for (const failure of s.failures) lines.push([`Failed: ${failure.reason} — ${failure.text}`, true]);
		const timeouts = view.loader.timeouts;
		lines.push([`Rewards loader timeouts: ${timeouts.length}${timeouts.length ? ` (${timeouts.join(', ')})` : ''}`, timeouts.length > 0]);
		lines.push([`Last scan: ${view.lastScanAt} (${view.scanMs} ms)`]);
		return lines;
	}

	/** The small Hide / Unhide menu opened from a campaign header. */
	function createMenu(doc, win) {
		const menu = element(doc, 'div');
		menu.id = 'tres-menu';
		menu.setAttribute('data-tres', 'menu');
		menu.hidden = true;
		doc.body.appendChild(menu);
		let anchor = null;

		const close = () => {
			menu.hidden = true;
			anchor = null;
		};
		const onMouseDown = (event) => {
			if (!menu.hidden && !menu.contains(event.target) && event.target !== anchor) close();
		};
		const onKeyDown = (event) => {
			if (event.key === 'Escape') close();
		};
		doc.addEventListener('mousedown', onMouseDown, true);
		doc.addEventListener('keydown', onKeyDown, true);
		doc.addEventListener('scroll', close, true);

		return {
			element: menu,
			isOpen: () => !menu.hidden,
			open(target, items) {
				if (anchor === target && !menu.hidden) return close();
				anchor = target;
				menu.replaceChildren(...items.map((item) => {
					const node = element(doc, 'button', '', item.label);
					node.type = 'button';
					node.addEventListener('click', () => {
						close();
						item.run();
					});
					return node;
				}));
				menu.hidden = false;
				const rect = target.getBoundingClientRect();
				const width = menu.offsetWidth || 220;
				menu.style.top = `${Math.round(rect.bottom + 4)}px`;
				menu.style.left = `${Math.max(8, Math.round(Math.min(rect.right - width, win.innerWidth - width - 8)))}px`;
			},
			close,
			destroy() {
				doc.removeEventListener('mousedown', onMouseDown, true);
				doc.removeEventListener('keydown', onKeyDown, true);
				doc.removeEventListener('scroll', close, true);
				menu.remove();
			}
		};
	}

	/**
	 * Adds (once) the header controls (spec §4.2): a Hide button that hides just this campaign,
	 * a "⋯" button for the game/publisher options, and the show-hidden reason label.
	 */
	function decorateHeader(doc, campaign, reason, showHidden, hiddenByRule, progress) {
		const header = campaign.rootEl.firstElementChild;
		let controls = header.querySelector(':scope > .tres-controls');
		if (!controls) {
			controls = element(doc, 'span', 'tres-controls');
			controls.setAttribute('data-tres', 'controls');
			const progressPill = element(doc, 'span', 'tres-header-progress');
			progressPill.hidden = true;
			const reasonLabel = element(doc, 'span', 'tres-reason');
			reasonLabel.hidden = true;
			const hideButton = element(doc, 'button', 'tres-hide-btn');
			hideButton.type = 'button';
			const moreButton = element(doc, 'button', 'tres-more-btn', '⋯');
			moreButton.type = 'button';
			moreButton.title = 'More: hide all campaigns for this game or publisher';
			moreButton.setAttribute('aria-label', 'More hide options');
			controls.append(progressPill, reasonLabel, hideButton, moreButton);
			header.appendChild(controls);
		}
		const progressPill = controls.querySelector('.tres-header-progress');
		const progressText = progress ? progress.text : '';
		if (progressPill.textContent !== progressText) progressPill.textContent = progressText;
		progressPill.title = progress ? progress.title : '';
		progressPill.hidden = !progress;
		const hideButton = controls.querySelector('.tres-hide-btn');
		const hideText = hiddenByRule ? 'Unhide' : 'Hide';
		if (hideButton.textContent !== hideText) hideButton.textContent = hideText;
		hideButton.title = hiddenByRule ? 'Unhide this campaign' : 'Hide this campaign';
		hideButton.dataset.campaignId = campaign.id;
		controls.querySelector('.tres-more-btn').dataset.campaignId = campaign.id;
		const reasonLabel = controls.querySelector('.tres-reason');
		const text = reason && showHidden ? `hidden: ${REASON_LABELS[reason]}` : '';
		if (reasonLabel.textContent !== text) reasonLabel.textContent = text;
		reasonLabel.hidden = !text;
	}

	/** The pill text for an Inventory progress entry (spec §11.4). */
	function progressLabel(progress) {
		if (progress.state === 'claimable') return 'Ready to claim';
		if (progress.state === 'connect') return '100% · connect account';
		if (progress.state === 'complete') return '100%';
		return progress.requiredText ? `${progress.percent}% of ${progress.requiredText}` : `${progress.percent}%`;
	}

	/**
	 * The campaign header's progress pill (spec §11.4): "{claimed}/{total} claimed", plus the highest
	 * in-progress percentage. Null when no reward is claimed or in progress.
	 */
	function campaignProgress(campaign, claimed, progressByKey) {
		const rewards = campaign.rewards || [];
		const done = rewards.filter((reward) => claimed[reward.key]).length;
		const active = rewards.filter((reward) => !claimed[reward.key] && progressByKey.has(reward.key)).map((reward) => progressByKey.get(reward.key));
		if (!done && !active.length) return null;
		const max = active.length ? Math.max(...active.map((progress) => progress.percent)) : null;
		const stateOf = (reward) => {
			const claim = claimed[reward.key];
			if (claim) return claim.source === 'inventory' ? 'claimed (Inventory)' : 'claimed';
			return progressByKey.has(reward.key) ? progressLabel(progressByKey.get(reward.key)) : 'no progress';
		};
		return {
			text: `${done}/${rewards.length} claimed${max === null ? '' : ` · ${max}%`}`,
			title: rewards.map((reward) => `${reward.name}: ${stateOf(reward)}`).join('\n')
		};
	}

	/**
	 * Adds (once) the "Claimed" checkbox to each reward tile, dims tiles that are done, and shows
	 * Inventory progress on the image of rewards that aren't claimed (spec §11.4).
	 */
	function decorateTiles(doc, campaign, rules, claimed, progressByKey) {
		if (campaign.rewardsSource !== 'page') return;
		for (const reward of campaign.rewards) {
			const tile = reward.tileEl;
			if (!tile || !tile.isConnected) continue;
			const container = tile.querySelector('.drop-benefit__image-container');
			if (!container) continue;
			let control = container.querySelector(':scope > .tres-claim');
			if (!control) {
				control = element(doc, 'label', 'tres-claim');
				control.setAttribute('data-tres', 'claim');
				control.title = 'Mark this reward as claimed';
				const input = element(doc, 'input');
				input.type = 'checkbox';
				control.append(input, element(doc, 'span', '', 'Claimed'));
				const note = element(doc, 'span', 'tres-done-reason');
				note.setAttribute('data-tres', 'done-reason');
				note.hidden = true;
				container.append(control, note);
			}
			const input = control.querySelector('input');
			input.dataset.rewardKey = reward.key;
			input.dataset.campaignId = campaign.id;
			input.checked = Boolean(claimed[reward.key]);
			const claim = claimed[reward.key];
			const progress = claim ? null : progressByKey.get(reward.key) || null;
			const typeHidden = rules.hiddenRewardTypes.includes(normalize(reward.type));
			const note = container.querySelector(':scope > .tres-done-reason');
			// The progress pill takes the bottom of the image, so it replaces the hidden-type note.
			const noteText = claim ? (claim.source === 'inventory' ? 'claimed (Inventory)' : '') : typeHidden && !progress ? `hidden type: ${reward.type}` : '';
			if (note.textContent !== noteText) note.textContent = noteText;
			note.hidden = !noteText;
			decorateProgress(doc, container, progress);
			if (rewardDone(reward, rules, claimed)) tile.setAttribute('data-tres-done', '');
			else tile.removeAttribute('data-tres-done');
		}
	}

	/** An Inventory-style progress bar and pill along the bottom of a reward image, or none. */
	function decorateProgress(doc, container, progress) {
		let bar = container.querySelector(':scope > .tres-progress');
		let pill = container.querySelector(':scope > .tres-progress-pill');
		if (!progress) {
			if (bar) bar.remove();
			if (pill) pill.remove();
			container.removeAttribute('data-tres-in-progress');
			return;
		}
		if (!bar) {
			bar = element(doc, 'div', 'tres-progress');
			bar.setAttribute('data-tres', 'progress');
			bar.append(element(doc, 'div'));
			pill = element(doc, 'span', 'tres-progress-pill');
			pill.setAttribute('data-tres', 'progress-pill');
			container.append(bar, pill);
		}
		const width = `${Math.min(100, Math.max(0, progress.percent))}%`;
		if (bar.firstElementChild.style.width !== width) bar.firstElementChild.style.width = width;
		const text = progressLabel(progress);
		if (pill.textContent !== text) pill.textContent = text;
		pill.title = `From the Inventory: ${text}`;
		if (progress.percent < 100) container.setAttribute('data-tres-in-progress', '');
		else container.removeAttribute('data-tres-in-progress');
	}

	/**
	 * Orders each section's campaigns visually with CSS `order` on a flex container, never by
	 * moving Twitch's nodes (spec §4.6). Dimmed campaigns go to the bottom; "twitch" order with
	 * nothing dimmed in a section removes our ordering from it entirely.
	 */
	function applySort(result, sortBy, reasons, showHidden) {
		const isDimmed = (campaign) => showHidden && Boolean(reasons.get(campaign.id));
		const containers = new Map();
		for (const campaign of result.campaigns) {
			const container = campaign.rootEl.parentElement;
			if (!container) continue;
			if (!containers.has(container)) containers.set(container, []);
			containers.get(container).push(campaign);
		}
		for (const [container, campaigns] of containers) {
			if (sortBy === 'twitch' && !campaigns.some(isDimmed)) {
				clearSort(container);
				continue;
			}
			container.classList.add('tres-sorted');
			displayOrder(campaigns, sortBy, isDimmed).forEach((campaign, index) => {
				if (campaign.rootEl.style.order !== String(index)) campaign.rootEl.style.order = String(index);
			});
		}
	}

	function clearSort(container) {
		if (!container.classList.contains('tres-sorted')) return;
		container.classList.remove('tres-sorted');
		for (const child of container.children) child.style.removeProperty('order');
	}

	function clearDecorations(content) {
		if (!content) return;
		for (const container of content.querySelectorAll('.tres-sorted')) clearSort(container);
		for (const heading of content.querySelectorAll('h4.tres-counted')) heading.classList.remove('tres-counted');
		for (const node of content.querySelectorAll('[data-tres]')) node.remove();
		for (const node of content.querySelectorAll('.tres-hidden, .tres-dimmed')) node.classList.remove('tres-hidden', 'tres-dimmed');
		for (const node of content.querySelectorAll('[data-tres-done]')) node.removeAttribute('data-tres-done');
		for (const node of content.querySelectorAll('[data-tres-in-progress]')) node.removeAttribute('data-tres-in-progress');
	}

	/**
	 * Shows "N hidden" (or "N dimmed" in show-hidden mode) beside each section heading that has
	 * hidden campaigns (spec §4.4). On Open sections the counter is a button that toggles
	 * show-hidden mode. The counter is the heading's next sibling, never inside the <h4>, so the
	 * heading text the extractor reads is unchanged; `tres-counted` puts the two on one line.
	 */
	function updateSectionCounts(doc, result, reasons, showHidden) {
		for (const { type, heading } of result.sections) {
			const inSection = result.campaigns.filter((campaign) => campaign.type === type);
			const hidden = inSection.filter((campaign) => reasons.get(campaign.id)).length;
			const toggles = type !== CLOSED_TYPE;
			let counter = heading.nextElementSibling && heading.nextElementSibling.matches('.tres-section-count') ? heading.nextElementSibling : null;
			if (counter && (counter.tagName === 'BUTTON') !== toggles) {
				counter.remove();
				counter = null;
			}
			if (!hidden) {
				if (counter) counter.remove();
				heading.classList.remove('tres-counted');
				continue;
			}
			if (!counter) {
				counter = element(doc, toggles ? 'button' : 'span', 'tres-section-count');
				counter.setAttribute('data-tres', 'section-count');
				if (toggles) counter.type = 'button';
				heading.after(counter);
			}
			heading.classList.add('tres-counted');
			const text = `${hidden} ${showHidden ? 'dimmed' : 'hidden'}`;
			if (counter.textContent !== text) counter.textContent = text;
			const summary = `${hidden} of ${inSection.length} campaigns in this section are ${showHidden ? 'hidden, shown dimmed' : 'hidden'}`;
			counter.title = toggles ? `${summary}. Click to ${showHidden ? 'hide them again' : 'show them dimmed'}.` : summary;
			if (toggles) counter.setAttribute('aria-pressed', String(showHidden));
		}
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

	function idleLoader() {
		return { running: false, cancelled: false, mode: null, total: 0, done: 0, timeouts: [] };
	}

	/** The scroll positions of every scrolled ancestor of `node`, so they can be put back later. */
	function saveScroll(win, node) {
		const saved = [];
		for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
			if (current.scrollTop) saved.push([current, current.scrollTop]);
		}
		return { saved, x: win.scrollX || 0, y: win.scrollY || 0 };
	}

	function restoreScroll(win, positions) {
		for (const [node, top] of positions.saved) if (node.isConnected) node.scrollTop = top;
		if (positions.y || positions.x) win.scrollTo(positions.x, positions.y);
	}

	function createApp(win, storage, options) {
		const doc = win.document;
		const clock = options.now || (() => Date.now());
		const loaderPollMs = options.loaderPollMs || LOADER_POLL_MS;
		const state = {
			active: false,
			content: null,
			observer: null,
			scanner: null,
			panel: null,
			menu: null,
			data: loadData(storage),
			dirty: new Set(),
			result: null,
			reasons: new Map(),
			inventory: null,
			match: matchInventory([], null),
			claimed: {},
			unwatch: null,
			lastScanAt: null,
			scanMs: 0,
			scanCount: 0,
			loader: idleLoader(),
			timers: { scan: 0, wait: 0, tick: 0, write: 0 }
		};

		function route() {
			const wanted = isCampaignsPath(win.location.pathname);
			if (wanted && !state.active) activate();
			else if (!wanted && state.active) deactivate();
			else if (wanted && state.content && doc.querySelector(CONTENT_SELECTOR) !== state.content) reattach();
		}

		function activate() {
			state.active = true;
			state.data = loadData(storage);
			if (prune(state.data, clock())) persist();
			state.inventory = readInventory(storage);
			// Live sync (spec §11.2): a read in the Inventory tab re-applies the rules here at once.
			if (storage.watchInventory) {
				state.unwatch = storage.watchInventory(() => {
					state.inventory = readInventory(storage);
					applyAll();
				});
			}
			state.scanner = createScanner();
			state.panel = createPanel(doc, win, actions);
			state.menu = createMenu(doc, win);
			waitForContent();
			state.timers.tick = win.setInterval(() => scanNow(), STATUS_TICK_MS);
		}

		function deactivate() {
			state.active = false;
			state.loader.cancelled = true;
			win.clearTimeout(state.timers.scan);
			win.clearTimeout(state.timers.wait);
			win.clearInterval(state.timers.tick);
			if (state.unwatch) state.unwatch();
			state.unwatch = null;
			flushWrite();
			detach();
			if (state.panel) state.panel.destroy();
			if (state.menu) state.menu.destroy();
			Object.assign(state, { scanner: null, panel: null, menu: null, result: null });
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
			content.addEventListener('click', onContentClick, true);
			content.addEventListener('change', onContentChange, true);
			scanNow();
		}

		function detach() {
			if (state.observer) state.observer.disconnect();
			if (state.content) {
				state.content.removeEventListener('click', onContentClick, true);
				state.content.removeEventListener('change', onContentChange, true);
				clearDecorations(state.content);
			}
			state.observer = null;
			state.content = null;
		}

		function reattach() {
			detach();
			state.scanner = createScanner();
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
			const started = clock();
			const timer = Date.now();
			state.result = state.scanner.scan(state.content, started, state.dirty);
			state.dirty.clear();
			state.scanCount += 1;
			if (state.result.recognized && learnCampaigns(state.result.campaigns, state.data, started)) persist();
			state.scanMs = Date.now() - timer;
			state.lastScanAt = new Date(started).toLocaleTimeString();
			applyAll();
			return state.result;
		}

		/** Applies the rules to the page and refreshes the panel. Never triggers a scan. */
		function applyAll() {
			const result = state.result;
			if (!result || !state.panel) return;
			const { rules } = state.data;
			const enabled = result.recognized;
			state.match = matchInventory(result.campaigns, state.inventory);
			const claimed = state.claimed = effectiveClaims(state.data, state.match);
			const progressByKey = state.match.progressByKey;
			state.reasons = new Map();
			if (!enabled) clearDecorations(state.content);
			for (const campaign of result.campaigns) {
				const reason = enabled ? hideReason(campaign, rules, claimed) : null;
				state.reasons.set(campaign.id, reason);
				if (!enabled) continue;
				campaign.rootEl.classList.toggle('tres-hidden', Boolean(reason) && !rules.showHidden);
				campaign.rootEl.classList.toggle('tres-dimmed', Boolean(reason) && rules.showHidden);
				decorateHeader(doc, campaign, reason, rules.showHidden, Boolean(rules.hiddenCampaigns[campaign.id]), campaignProgress(campaign, claimed, progressByKey));
				decorateTiles(doc, campaign, rules, claimed, progressByKey);
			}
			if (enabled) {
				updateSectionCounts(doc, result, state.reasons, rules.showHidden);
				applySort(result, rules.sortBy, state.reasons, rules.showHidden);
			}
			state.panel.update(buildView());
		}

		function buildView() {
			const result = state.result;
			const { rules, claimed } = state.data;
			const campaigns = result.campaigns;
			const hidden = campaigns.filter((campaign) => state.reasons.get(campaign.id)).length;
			const onPage = new Set(campaigns.map((campaign) => campaign.id));

			const typeStats = new Map();
			for (const campaign of campaigns) {
				const types = new Set();
				for (const reward of campaign.rewards || []) {
					const key = normalize(reward.type);
					if (!typeStats.has(key)) typeStats.set(key, { label: reward.type, rewards: 0, only: 0 });
					typeStats.get(key).rewards += 1;
					types.add(key);
				}
				if (types.size === 1) typeStats.get([...types][0]).only += 1;
			}
			for (const key of rules.hiddenRewardTypes) if (!typeStats.has(key)) typeStats.set(key, { label: key, rewards: 0, only: 0 });
			const rewardTypes = [...typeStats].sort((a, b) => a[1].label.localeCompare(b[1].label)).map(([key, stats]) => ({
				key,
				label: stats.label,
				count: `${stats.rewards} rewards · ${stats.only} only-${stats.label}`,
				checked: rules.hiddenRewardTypes.includes(key)
			}));

			const group = (list, includeOrphans) => {
				const publishers = new Map();
				const games = new Map();
				for (const campaign of list) {
					const publisher = publishers.get(campaign.publisherKey) || { label: campaign.publisher, count: 0 };
					publisher.count += 1;
					publishers.set(campaign.publisherKey, publisher);
					const game = games.get(campaign.gameKey) || { label: `${campaign.game} — ${campaign.publisher}`, count: 0 };
					game.count += 1;
					games.set(campaign.gameKey, game);
				}
				// Hidden games/publishers no longer on the page stay listed so they can be unhidden.
				if (includeOrphans) {
					for (const [key, entry] of Object.entries(rules.hiddenPublishers)) if (!publishers.has(key)) publishers.set(key, { label: entry.publisher || key, count: 0 });
					for (const [key, entry] of Object.entries(rules.hiddenGames)) if (!games.has(key)) games.set(key, { label: `${entry.game || key} — ${entry.publisher || ''}`, count: 0 });
				}
				const items = (map, hiddenMap) => [...map].sort((a, b) => a[1].label.localeCompare(b[1].label))
					.map(([key, entry]) => ({ key, label: entry.label, count: entry.count, checked: Boolean(hiddenMap[key]) }));
				return { count: list.length, publishers: items(publishers, rules.hiddenPublishers), games: items(games, rules.hiddenGames) };
			};

			const claimedEntries = Object.values(claimed);
			return {
				found: result.found,
				recognized: result.recognized,
				now: clock(),
				counts: {
					total: campaigns.length,
					hidden,
					visible: campaigns.length - hidden,
					closed: campaigns.filter((campaign) => campaign.closed).length,
					upcoming: campaigns.filter((campaign) => campaign.status === 'upcoming').length
				},
				rules: { hideClosed: rules.hideClosed, hideUpcoming: rules.hideUpcoming, showHidden: rules.showHidden, sortBy: rules.sortBy },
				rewardsKnown: campaigns.filter((campaign) => campaign.rewards).length,
				rewardTypes,
				groups: {
					open: group(campaigns.filter((campaign) => campaign.type !== CLOSED_TYPE), true),
					closed: group(campaigns.filter((campaign) => campaign.type === CLOSED_TYPE), false)
				},
				hiddenCampaigns: Object.entries(rules.hiddenCampaigns)
					.map(([id, entry]) => ({
						id,
						label: `${entry.game} — ${entry.publisher} · ${entry.title ? `${entry.title} · ` : ''}${entry.dateText}${onPage.has(id) ? '' : ' (not on page)'}`
					}))
					.sort((a, b) => a.label.localeCompare(b.label)),
				claimed: { total: claimedEntries.length, orphans: claimedEntries.filter((claim) => !onPage.has(claim.campaignId)).length },
				inventory: {
					readAt: state.inventory ? state.inventory.readAt : null,
					complete: Boolean(state.inventory && state.inventory.complete),
					matched: { ...state.match.matched },
					unmatched: { ...state.match.unmatched }
				},
				lastExportAt: state.data.lastExportAt,
				loader: { ...state.loader, timeouts: [...state.loader.timeouts] },
				summary: summarize(result),
				lastScanAt: state.lastScanAt,
				scanMs: state.scanMs
			};
		}

		function persist() {
			win.clearTimeout(state.timers.write);
			state.timers.write = win.setTimeout(flushWrite, WRITE_DEBOUNCE_MS);
		}

		function flushWrite() {
			if (!state.timers.write) return;
			win.clearTimeout(state.timers.write);
			state.timers.write = 0;
			try {
				storage.write(state.data);
			} catch (error) {
				console.warn(LOG_PREFIX, 'could not save', error);
			}
		}

		/** Every user action changes data, saves it and re-applies the rules; none of them rescans. */
		function update(change) {
			change(state.data);
			persist();
			applyAll();
		}

		function findCampaign(id) {
			return state.result ? state.result.campaigns.find((campaign) => campaign.id === id) : null;
		}

		function wait(ms) {
			return new Promise((resolve) => win.setTimeout(resolve, ms));
		}

		function toggleButtonOf(root) {
			return root && root.isConnected ? root.firstElementChild.querySelector('button[aria-expanded]') : null;
		}

		/** Size of a body's own content, ignoring our decorations (which change while we wait). */
		function bodySignature(body) {
			if (!body || !body.children.length) return '';
			const own = body.querySelectorAll('[data-tres], [data-tres] *').length;
			return `${body.querySelectorAll('.drop-benefit__image-container').length}|${body.querySelectorAll('*').length - own}|${body.textContent.length}`;
		}

		/** Waits until a campaign body has content that has stopped changing. Returns false on timeout. */
		async function waitForBody(root) {
			let last = '';
			let stable = 0;
			for (let waited = 0; waited < LOADER_MAX_WAIT_MS; waited += loaderPollMs) {
				await wait(loaderPollMs);
				if (state.loader.cancelled || !root.isConnected) return false;
				const signature = bodySignature(root.children[1]);
				stable = signature && signature === last ? stable + 1 : 0;
				last = signature;
				if (stable >= LOADER_STABLE_POLLS) return true;
			}
			return false;
		}

		/**
		 * Opens campaigns one at a time and reads their rewards (spec §4.5). Only runs when the
		 * user asks. `mode` is 'unknown' (only campaigns whose rewards aren't known) or 'all'.
		 */
		async function loadRewards(mode) {
			if (state.loader.running || !state.result || !state.result.recognized) return;
			const targets = state.result.campaigns.filter((campaign) => mode === 'all' || !campaign.rewards);
			if (!targets.length) return;
			const loader = state.loader = { ...idleLoader(), running: true, mode, total: targets.length };
			const scroll = saveScroll(win, state.content);
			const originallyOpen = state.result.campaigns.find((campaign) => campaign.expanded);
			const originalRoot = originallyOpen ? originallyOpen.rootEl : null;
			let lastRoot = null;
			applyAll();

			for (const campaign of targets) {
				if (loader.cancelled || !state.active) break;
				const toggle = toggleButtonOf(campaign.rootEl);
				if (toggle) {
					if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
					lastRoot = campaign.rootEl;
					const loaded = await waitForBody(campaign.rootEl);
					if (loader.cancelled) break;
					if (!loaded) loader.timeouts.push(campaign.game);
					state.dirty.add(campaign.rootEl);
				}
				loader.done += 1;
				scanNow();
			}

			// Put the page back the way it was: the campaign the user had open, and the scroll position.
			const originalToggle = toggleButtonOf(originalRoot);
			if (originalToggle) {
				if (originalToggle.getAttribute('aria-expanded') !== 'true') originalToggle.click();
			} else {
				const lastToggle = toggleButtonOf(lastRoot);
				if (lastToggle && lastToggle.getAttribute('aria-expanded') === 'true') lastToggle.click();
			}
			restoreScroll(win, scroll);
			loader.running = false;
			if (state.active) scanNow();
		}

		const actions = {
			setRule(name, value) {
				update((data) => { data.rules[name] = value; });
			},
			setRewardType(key, hide) {
				update((data) => {
					const types = new Set(data.rules.hiddenRewardTypes);
					if (hide) types.add(key);
					else types.delete(key);
					data.rules.hiddenRewardTypes = [...types];
				});
			},
			setGame(key, hide) {
				const campaign = state.result && state.result.campaigns.find((c) => c.gameKey === key);
				update((data) => {
					if (hide) data.rules.hiddenGames[key] = campaign ? { game: campaign.game, publisher: campaign.publisher } : data.rules.hiddenGames[key] || {};
					else delete data.rules.hiddenGames[key];
				});
			},
			setPublisher(key, hide) {
				const campaign = state.result && state.result.campaigns.find((c) => c.publisherKey === key);
				update((data) => {
					if (hide) data.rules.hiddenPublishers[key] = campaign ? { publisher: campaign.publisher } : data.rules.hiddenPublishers[key] || {};
					else delete data.rules.hiddenPublishers[key];
				});
			},
			setCampaign(id, hide) {
				const campaign = findCampaign(id);
				update((data) => {
					if (hide && campaign) {
						data.rules.hiddenCampaigns[id] = {
							game: campaign.game, publisher: campaign.publisher, dateText: campaign.dateText, title: campaign.title, hiddenAt: clock()
						};
					} else if (!hide) {
						delete data.rules.hiddenCampaigns[id];
					}
				});
			},
			unhideCampaign(id) {
				actions.setCampaign(id, false);
			},
			loadRewards(mode) {
				return loadRewards(mode);
			},
			cancelLoad() {
				state.loader.cancelled = true;
				applyAll();
			},
			/**
			 * The tile's Claimed toggle (spec §11.4). For a reward the Inventory reports claimed,
			 * unticking records an override and ticking removes it; otherwise it's a manual mark.
			 */
			setClaimed(rewardKey, campaignId, claimedNow) {
				const campaign = findCampaign(campaignId);
				const reward = campaign && campaign.rewards && campaign.rewards.find((r) => r.key === rewardKey);
				const fromInventory = state.match.claimedKeys.has(rewardKey);
				update((data) => {
					if (claimedNow) {
						delete data.inventoryOverrides[rewardKey];
						if (!fromInventory) data.claimed[rewardKey] = { name: reward ? reward.name : '', campaignId, claimedAt: clock() };
					} else {
						delete data.claimed[rewardKey];
						if (fromInventory) data.inventoryOverrides[rewardKey] = { at: clock(), campaignId };
					}
				});
			},
			clearInventory() {
				if (!win.confirm('Forget everything read from the Inventory? Rewards you ticked yourself stay claimed.')) return '';
				storage.writeInventory(null);
				state.inventory = null;
				applyAll();
				return 'Inventory claims cleared.';
			},
			/** Goes to the Inventory through Twitch's own tab link, so the single-page app handles it. */
			openInventory() {
				const link = [...doc.querySelectorAll(`a[href="${INVENTORY_PATH}"], a[href$="twitch.tv${INVENTORY_PATH}"]`)].find((node) => !node.closest('[data-tres]'));
				if (link) link.click();
				else win.location.assign(INVENTORY_PATH);
			},
			clearOrphanClaims() {
				const onPage = new Set(state.result ? state.result.campaigns.map((campaign) => campaign.id) : []);
				update((data) => {
					for (const [key, claim] of Object.entries(data.claimed)) if (!onPage.has(claim.campaignId)) delete data.claimed[key];
				});
			},
			exportData() {
				const now = clock();
				const filename = `tres-drop-campaigns-backup-${localDateStamp(now)}.json`;
				state.data.lastExportAt = now;
				const json = JSON.stringify({ ...state.data, inventory: state.inventory }, null, 2);
				try {
					const url = win.URL.createObjectURL(new win.Blob([json], { type: 'application/json' }));
					const link = element(doc, 'a');
					link.href = url;
					link.download = filename;
					link.setAttribute('data-tres', 'download');
					doc.body.appendChild(link);
					link.click();
					link.remove();
					win.setTimeout(() => win.URL.revokeObjectURL(url), 10000);
				} catch (error) {
					console.log(LOG_PREFIX, 'backup:', json);
					return 'Download failed; the backup was logged to the console.';
				}
				persist();
				applyAll();
				return `Exported ${filename}.`;
			},
			async importFile(file) {
				try {
					const imported = JSON.parse(await file.text());
					if (!isPlainObject(imported) || imported.schema !== SCHEMA) return 'Import failed: not a TRES backup file.';
					state.data = mergeImport(state.data, imported);
					// The backup's Inventory snapshot replaces ours only if it was read later (spec §11.6).
					const inventory = sanitizeInventory(imported.inventory);
					if (inventory && (!state.inventory || inventory.readAt > state.inventory.readAt)) {
						state.inventory = inventory;
						storage.writeInventory(inventory);
					}
					persist();
					applyAll();
					return 'Imported and merged.';
				} catch (error) {
					return `Import failed: ${error.message}`;
				}
			},
			resetAll() {
				if (!win.confirm('Reset all TRES filters and claimed marks? Learned rewards are kept.')) return '';
				const fresh = defaultData();
				update((data) => {
					data.rules = fresh.rules;
					data.claimed = {};
					// The Inventory snapshot is data read from Twitch, not a setting, so it stays (spec §11.6).
					data.inventoryOverrides = {};
				});
				return 'Filters and claimed marks reset.';
			},
			async copyModel() {
				const json = JSON.stringify({
					capturedAt: new Date().toISOString(),
					url: win.location.href,
					summary: state.result ? summarize(state.result) : null,
					campaigns: state.result ? state.result.campaigns.map((campaign) => ({ ...plainCampaign(campaign), hiddenBy: state.reasons.get(campaign.id) || null })) : [],
					stored: state.data,
					inventory: state.inventory,
					inventoryMatch: {
						matched: state.match.matched,
						unmatched: state.match.unmatched,
						claimedKeys: [...state.match.claimedKeys],
						progress: Object.fromEntries(state.match.progressByKey)
					}
				}, null, 2);
				try {
					await win.navigator.clipboard.writeText(json);
					return true;
				} catch (error) {
					console.log(LOG_PREFIX, 'model:', json);
					return false;
				}
			}
		};

		/**
		 * Our buttons inside Twitch's content, handled here in the capture phase so the click never
		 * reaches Twitch's handlers. Hide acts at once on this campaign; "⋯" opens the
		 * game/publisher menu; an Open section's counter pill toggles show-hidden mode.
		 */
		function onContentClick(event) {
			const target = event.target.closest && event.target.closest('[data-tres]');
			if (!target) return;
			event.stopPropagation();
			if (event.target.closest('button.tres-section-count')) {
				event.preventDefault();
				actions.setRule('showHidden', !state.data.rules.showHidden);
				return;
			}
			const button = event.target.closest('.tres-hide-btn, .tres-more-btn');
			if (!button) return;
			event.preventDefault();
			const campaign = findCampaign(button.dataset.campaignId);
			if (!campaign) return;
			const { rules } = state.data;
			if (button.matches('.tres-hide-btn')) {
				actions.setCampaign(campaign.id, !rules.hiddenCampaigns[campaign.id]);
				return;
			}
			const toggle = (hidden, hideLabel, unhideLabel, run) => ({ label: hidden ? unhideLabel : hideLabel, run: () => run(!hidden) });
			state.menu.open(button, [
				toggle(Boolean(rules.hiddenGames[campaign.gameKey]), `Hide all ${campaign.game}`, `Unhide all ${campaign.game}`, (hide) => actions.setGame(campaign.gameKey, hide)),
				toggle(Boolean(rules.hiddenPublishers[campaign.publisherKey]), `Hide all from ${campaign.publisher}`, `Unhide all from ${campaign.publisher}`, (hide) => actions.setPublisher(campaign.publisherKey, hide))
			]);
		}

		function onContentChange(event) {
			const input = event.target;
			if (!input.matches || !input.matches('.tres-claim input[type="checkbox"]')) return;
			event.stopPropagation();
			actions.setClaimed(input.dataset.rewardKey, input.dataset.campaignId, input.checked);
		}

		return { route, scanNow, applyAll, deactivate, actions, state, flushWrite };
	}

	function readInventory(storage) {
		try {
			return storage.readInventory ? sanitizeInventory(storage.readInventory()) : null;
		} catch (error) {
			console.warn(LOG_PREFIX, 'could not read the Inventory snapshot', error);
			return null;
		}
	}

	/**
	 * The Inventory page (spec §11.2, §11.5): reads what the page shows on arrival and after each
	 * change, and saves it as the snapshot the Campaigns page matches against. Never writes the
	 * settings, and never clicks Load More unless the user starts Scan full history.
	 */
	function createInventoryApp(win, storage, options) {
		const doc = win.document;
		const clock = options.now || (() => Date.now());
		const pollMs = options.loaderPollMs || LOADER_POLL_MS;
		const state = {
			active: false,
			content: null,
			observer: null,
			panel: null,
			result: null,
			// Each claim's window is fixed when its time text is first seen, because Twitch
			// doesn't re-render the text while the page stays open.
			windows: new WeakMap(),
			signature: null,
			writtenAt: 0,
			lastReadAt: null,
			readMs: 0,
			history: idleHistory(),
			timers: { read: 0, wait: 0 }
		};

		function idleHistory() {
			return { running: false, cancelled: false, finished: false, timedOut: false, clicks: 0 };
		}

		function route() {
			const wanted = isInventoryPath(win.location.pathname);
			if (wanted && !state.active) activate();
			else if (!wanted && state.active) deactivate();
			else if (wanted && state.content && doc.querySelector(CONTENT_SELECTOR) !== state.content) {
				detach();
				waitForContent();
			}
		}

		function activate() {
			state.active = true;
			state.panel = createInventoryPanel(doc, win, actions);
			state.signature = null;
			waitForContent();
			render();
		}

		function deactivate() {
			state.active = false;
			state.history.cancelled = true;
			win.clearTimeout(state.timers.read);
			win.clearTimeout(state.timers.wait);
			detach();
			if (state.panel) state.panel.destroy();
			Object.assign(state, { panel: null, result: null });
		}

		function waitForContent() {
			const content = doc.querySelector(CONTENT_SELECTOR);
			if (content) attach(content);
			else state.timers.wait = win.setTimeout(waitForContent, CONTENT_WAIT_MS);
		}

		function attach(content) {
			state.content = content;
			state.observer = new win.MutationObserver(scheduleRead);
			state.observer.observe(content, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-valuenow'] });
			readNow();
		}

		function detach() {
			if (state.observer) state.observer.disconnect();
			state.observer = null;
			state.content = null;
		}

		function scheduleRead() {
			win.clearTimeout(state.timers.read);
			state.timers.read = win.setTimeout(readNow, SCAN_DEBOUNCE_MS);
		}

		function windowOf(img, timeText) {
			const cached = state.windows.get(img);
			if (cached && cached.timeText === timeText) return cached.span;
			const span = relativeWindow(timeText, clock());
			state.windows.set(img, { timeText, span });
			return span;
		}

		/** Reads the page, and saves the snapshot when it changed (or the last save is a minute old). */
		function readNow() {
			if (!state.active || !state.content) return null;
			const now = clock();
			const timer = Date.now();
			const result = state.result = extractInventory(state.content, now, windowOf);
			state.readMs = Date.now() - timer;
			state.lastReadAt = new Date(now).toLocaleTimeString();
			if (result.ready) {
				const { readAt, ...rest } = result.snapshot;
				const signature = JSON.stringify(rest);
				if (signature !== state.signature || now - state.writtenAt >= INVENTORY_REFRESH_MS) {
					state.signature = signature;
					state.writtenAt = now;
					try {
						storage.writeInventory(result.snapshot);
					} catch (error) {
						console.warn(LOG_PREFIX, 'could not save the Inventory snapshot', error);
					}
				}
			}
			render();
			return result;
		}

		function render() {
			if (!state.panel) return;
			const result = state.result;
			state.panel.update({
				found: Boolean(result && result.found),
				now: clock(),
				snapshot: readInventory(storage),
				loadMore: Boolean(result && result.loadMore),
				history: { ...state.history },
				diagnostics: result ? result.diagnostics : { groups: 0, rewards: 0, claims: 0, unknownTimes: [] },
				lastReadAt: state.lastReadAt,
				readMs: state.readMs
			});
		}

		function wait(ms) {
			return new Promise((resolve) => win.setTimeout(resolve, ms));
		}

		function claimCount() {
			return state.content ? state.content.querySelectorAll(CLAIM_IMAGE_SELECTOR).length : 0;
		}

		/**
		 * Scan full history (spec §11.2): clicks Load More, waits for new claims to stop arriving,
		 * and repeats until the button is gone. Only runs when the user asks; can be cancelled.
		 */
		async function scanHistory() {
			if (state.history.running || !state.content) return;
			const history = state.history = { ...idleHistory(), running: true };
			render();
			while (!history.cancelled && state.active) {
				const page = state.content && state.content.querySelector('.inventory-page');
				const loadMore = page && findLoadMore(page);
				if (!loadMore) break;
				let count = claimCount();
				loadMore.click();
				history.clicks += 1;
				render();
				let grew = false;
				let stable = 0;
				for (let waited = 0; waited < LOADER_MAX_WAIT_MS && !history.cancelled; waited += pollMs) {
					await wait(pollMs);
					const next = claimCount();
					if (next > count) {
						grew = true;
						stable = 0;
						count = next;
					} else if (grew && ++stable >= LOADER_STABLE_POLLS) {
						break;
					}
				}
				if (!grew && !history.cancelled) {
					const stillThere = state.content && state.content.querySelector('.inventory-page') && findLoadMore(state.content.querySelector('.inventory-page'));
					history.timedOut = Boolean(stillThere);
					break;
				}
			}
			history.running = false;
			history.finished = true;
			if (state.active) readNow();
		}

		const actions = {
			scanHistory() {
				return scanHistory();
			},
			cancelScan() {
				state.history.cancelled = true;
				render();
			},
			clearAndRescan() {
				storage.writeInventory(null);
				state.signature = null;
				state.windows = new WeakMap();
				readNow();
				return 'Cleared and read again.';
			}
		};

		return { route, readNow, deactivate, actions, state };
	}

	/**
	 * Starts the script in `win`. Returns a handle with stop() for tests. `app` runs the
	 * Campaigns page and `inventory` the Inventory page; each activates only on its own route.
	 * `options.now` replaces the clock, so tests can run at a sample's capture time;
	 * `options.loaderPollMs` speeds up the rewards loader and Scan full history in tests.
	 */
	function start(win, storage, options = {}) {
		const app = createApp(win, storage, options);
		const inventory = createInventoryApp(win, storage, options);
		// Leaving a page tears it down before the next one starts, so only one panel ever exists.
		const route = () => {
			const apps = isInventoryPath(win.location.pathname) ? [app, inventory] : [inventory, app];
			for (const each of apps) each.route();
		};
		const history = win.history;
		const originals = { pushState: history.pushState, replaceState: history.replaceState };
		for (const name of Object.keys(originals)) {
			history[name] = function (...args) {
				const result = originals[name].apply(this, args);
				route();
				return result;
			};
		}
		win.addEventListener('popstate', route);
		// Fallback for route changes the history hooks can't see (e.g. sandboxed userscript scope).
		const routePoll = win.setInterval(route, ROUTE_POLL_MS);
		route();
		return {
			app,
			inventory,
			stop() {
				win.clearInterval(routePoll);
				win.removeEventListener('popstate', route);
				Object.assign(history, originals);
				app.deactivate();
				inventory.deactivate();
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
		defaultData,
		sanitizeData,
		loadData,
		mergeImport,
		prune,
		learnCampaigns,
		relativeWindow,
		extractInventory,
		sanitizeInventory,
		matchInventory,
		effectiveClaims,
		campaignProgress,
		progressLabel,
		rewardDone,
		hideReason,
		sortCampaigns,
		displayOrder,
		campaignRootOf,
		isOwnMutation,
		memoryStorage,
		start
	};

	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	else start(window, gmStorage());
})();
