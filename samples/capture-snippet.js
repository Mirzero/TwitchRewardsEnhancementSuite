// TRES sample capture helper (v2)
// Paste this whole file into the DevTools console on https://www.twitch.tv/drops/campaigns,
// then call tresCapture(). See samples_readme.md for which sample needs which call.
//
//   await tresCapture('page_source_default.html')               // page exactly as it is now
//   await tresCapture('page_source_opencampaigns.html', [])     // open every campaign in turn, stitch the bodies in
//   await tresCapture('some_name.html', ['Marvel Rivals'])      // open only campaigns for these game names
//
// The result is downloaded as a file (move it from Downloads into samples/).
// It is also kept in window.tresSample; if the download fails, run:  copy(tresSample)
// copy() only works when typed directly at the console prompt, not inside this script.

window.tresCapture = async function (filename, games) {
	const root = document.querySelector('.drops-root__content');
	if (!root) throw new Error('No .drops-root__content found. Is the All Campaigns list loaded?');
	const sel = '.accordion-header[role="heading"][aria-level="3"]';
	const headers = [...root.querySelectorAll(sel)];
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const captured = new Map();
	const problems = [];

	if (Array.isArray(games)) {
		for (const [i, header] of headers.entries()) {
			const game = header.querySelector('p')?.textContent.trim();
			if (games.length && !games.includes(game)) continue;
			const button = header.querySelector('button[aria-expanded]');
			if (button && button.getAttribute('aria-expanded') !== 'true') button.click();
			// Wait until the body has content and has stopped changing for 3 polls (max ~8s).
			let last = '';
			let stable = 0;
			for (let t = 0; t < 40 && stable < 3; t++) {
				await wait(200);
				const html = header.nextElementSibling?.innerHTML || '';
				stable = html && html === last ? stable + 1 : 0;
				last = html;
			}
			if (!header.isConnected) problems.push(`${game}: header was re-rendered by Twitch`);
			else if (!last) problems.push(`${game}: body stayed empty`);
			else if (stable < 3) problems.push(`${game}: body still changing after 8s`);
			captured.set(i, header.nextElementSibling?.cloneNode(true));
			console.log(`[tresCapture] ${captured.size} ${game}`);
		}
	}

	const clone = root.cloneNode(true);
	const cloneHeaders = [...clone.querySelectorAll(sel)];
	if (cloneHeaders.length !== headers.length) problems.push(`header count changed during capture (${headers.length} -> ${cloneHeaders.length})`);
	captured.forEach((body, i) => {
		if (!body || !cloneHeaders[i]) return;
		body.setAttribute('data-sample-expanded', 'true');
		cloneHeaders[i].nextElementSibling.replaceWith(body);
	});

	const meta = [
		`file: ${filename}`,
		`captured: ${new Date().toISOString()}`,
		`local: ${new Date().toString()}`,
		`tz: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
		`url: ${location.href}`,
		`mode: ${Array.isArray(games) ? (games.length ? `stitched [${games.join(', ')}]` : 'stitched [all]') : 'as-is'}`,
		`campaigns: ${headers.length}`,
		`stitched bodies: ${captured.size}`,
		`problems: ${problems.length ? problems.join('; ') : 'none'}`
	].join('\n');
	const html = `<!--\n${meta}\n-->\n${clone.outerHTML}`;
	window.tresSample = html;

	const link = document.createElement('a');
	link.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(link.href), 10000);

	if (problems.length) console.warn('[tresCapture] problems:\n' + problems.join('\n'));
	console.log(`[tresCapture] ${filename}: ${html.length} chars, ${headers.length} campaigns, ${captured.size} bodies stitched. Saved to window.tresSample.`);
	return meta;
};
console.log('[tresCapture] ready. Example: await tresCapture(\'page_source_default.html\')');
