import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCRIPT_PATH } from './helpers.mjs';

const RAW_URL = 'https://raw.githubusercontent.com/Mirzero/TwitchRewardsEnhancementSuite/main/TRES-DropCampaigns.user.js';

function metadata() {
	const source = readFileSync(SCRIPT_PATH, 'utf8');
	const block = source.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);
	assert.ok(block, 'metadata block present');
	const entries = {};
	for (const line of block[1].split('\n')) {
		const match = line.match(/^\/\/\s+@(\S+)\s+(.*?)\s*$/);
		if (match) (entries[match[1]] ||= []).push(match[2]);
	}
	return entries;
}

test('@version is valid SemVer', () => {
	const [version] = metadata().version;
	assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
});

test('@updateURL and @downloadURL point at the raw file on main', () => {
	const meta = metadata();
	assert.deepEqual(meta.updateURL, [RAW_URL]);
	assert.deepEqual(meta.downloadURL, [RAW_URL]);
});

test('@match covers all of twitch.tv', () => {
	assert.deepEqual(metadata().match, ['https://www.twitch.tv/*']);
});
