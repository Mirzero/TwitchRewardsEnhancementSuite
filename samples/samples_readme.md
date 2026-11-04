# Drops page samples

Snapshots of Twitch's rendered Drops pages, used to write the spec in `../prompt.md` and to run the extraction tests. Twitch changes its markup without notice, so when the script stops finding campaigns, re-capture these files and diff them against the old ones.

## Why not "Save Page As" or View Source

Those save the empty page Twitch's server sends. The campaign list is built afterwards by JavaScript, so those files contain no campaigns. Always capture with the console helper below. It saves only `.drops-root__content`, the element that holds the page content on both the Campaigns and Inventory tabs.

## Capture helper

1. Log in and open the page named in the table below. Wait until it has loaded.
2. Open DevTools (F12) and go to the **Console** tab.
3. Paste the full contents of `capture-snippet.js` and press Enter. It prints `[tresCapture] ready`. Paste it again after any page reload or tab change.
4. Run the `tresCapture(...)` call for the sample you want.
   - The file downloads to your **Downloads** folder. Move it into this folder, replacing the old copy.
   - If no download appears, type `copy(tresSample)` at the console prompt and paste the clipboard into the file.
5. Check the console for `problems:` warnings. Each file starts with a comment block recording when, where and how it was captured, and any problems.

Things to know:

- **Twitch only allows one campaign open at a time.** Opening one closes the others. For multi-campaign samples, the helper opens each campaign in turn and copies its body into one snapshot. The stitched bodies are marked `data-sample-expanded="true"`.
- **Closing a campaign doesn't remove its content.** Twitch only swaps a CSS class on the body. So a stitched file looks like what the page would hold if you had opened every campaign once. In a stitched file, `aria-expanded` is `false` everywhere except the last campaign opened.
- **Opening every campaign takes a few minutes.** Leave the tab alone while it runs.
- **Dates on the page are in your local timezone.** The file header records it (`tz:`), and the tests use the header's `captured:` time as "now".

## Samples

All of these exist except the paired and Open Reward samples, which are optional. They were captured on 2026-11-03 (America/Vancouver): the campaigns-page samples between 14:41 and 14:56, and the Inventory samples at 15:09, 18:44, 20:34 and 21:25.

| File | Page | How to capture | What it's for |
|---|---|---|---|
| `page_source_default.html` | /drops/campaigns | Reload. Don't open anything. Then run `await tresCapture('page_source_default.html')` | The collapsed baseline: headers, sections, dates, counts. |
| `page_source_opencampaigns.html` | /drops/campaigns | Prepare first (see below). Then run `await tresCapture('page_source_opencampaigns.html', [])` | Every campaign's body: title, reward names, reward types, earn requirements, connection state, closed watermark. |
| `page_source_single_expanded.html` | /drops/campaigns | Reload. Open one campaign by hand (ARC Raiders last time). Then run `await tresCapture('page_source_single_expanded.html')` | The real state the script sees: one body present, its button set to `aria-expanded="true"`. |
| `page_source_expand_then_collapse.html` | /drops/campaigns | Continue straight from the previous sample, without reloading. Close that same campaign, wait 2 seconds, then run `await tresCapture('page_source_expand_then_collapse.html')` | Shows Twitch keeps the body after closing and only changes `aria-expanded` and a CSS class. |
| `page_source_other_tab.html` | /drops/inventory | Click the **Inventory** tab (or open https://www.twitch.tv/drops/inventory). Click **Load More** under Claimed until it disappears, if you want the full history. Paste the snippet again, then run `await tresCapture('page_source_other_tab.html')`. The header will say `campaigns: 0`, which is expected. | The In Progress (with per-reward %) and Claimed lists, with the full history. Used by `tests/inventory.test.mjs`. |
| `page_source_inventory_default.html` | /drops/inventory | Reload Inventory and don't click anything, especially not Load More. Then run `await tresCapture('page_source_inventory_default.html')` | The Load More button's markup and how many claims the first page shows. `page_source_other_tab.html` was fully expanded, so it has neither. |
| `page_source_inventory_claimable.html` | /drops/inventory | When a reward shows **Claim Now** (100%, account connected) and you haven't clicked it yet. Run `await tresCapture('page_source_inventory_claimable.html')` | The claimable state. The 2026-11-03 capture shows THE FINALS rewards with Claim Now. |
| `page_source_inventory_just_claimed.html` | /drops/inventory | Within a few minutes after claiming. Run `await tresCapture('page_source_inventory_just_claimed.html')` | The minute form of the claim time ("32 minutes ago" in the 2026-11-03 capture), and a group leaving In Progress once claimed. |
| `page_source_inventory_paired.html` + `page_source_campaigns_paired.html` | both | **Optional; not captured** (hard to set up). Capture both a few minutes apart, on a day after you claimed a **recurring daily drop** (e.g. Albion Online or Black Desert) whose new instance is now listed. Inventory: `await tresCapture('page_source_inventory_paired.html')`. Campaigns: `await tresCapture('page_source_campaigns_paired.html', [])` | Tests the claim-matching rule: yesterday's claim must not mark today's instance claimed. Also shows whether claims can happen after a campaign has ended. Note which game you used. |
| `page_source_open_reward.html` | /drops/campaigns | Optional. Only when an "Open Reward Campaigns" section exists. Run `await tresCapture('page_source_open_reward.html', ['<game name>'])` | The Open Reward layout, which differs from Drop campaigns. No current sample. |

### Preparing for `page_source_opencampaigns.html`

The campaigns page shows the same body whatever your progress, so these states matter mostly for the Inventory sample captured at the same time:

- at least one campaign **partly watched**
- at least one campaign **fully claimed**
- at least one campaign requiring **account linking**, one linked and one not
- at least one **Closed** campaign, which normally exists anyway

State of the account at the 2026-11-03 capture:

| State | Game(s) |
|---|---|
| Partly watched | Marvel Rivals ("Season 10.5 Twitch Drops", 4–36%) and THE FINALS ("PRIME TIME", 7–31%) |
| Fully claimed | Enshrouded ("Enshrouded Artificer", all 6 rewards) |
| Account connected | Overwatch, Enshrouded, World of Warcraft. Everything else with a Connection section shows "Connect". |
| Expand-then-collapse game | ARC Raiders |

## What the samples showed

These findings feed `../prompt.md` §2.

- **Campaigns page:**
  - 102 campaigns: 84 Open Drop and 18 Closed Drop. There is no Open Reward section.
  - All 18 Closed campaigns had ended before capture. Every reward tile in a Closed campaign carries "This campaign has closed." (64 of 64 tiles). No Open campaign has it.
  - Reward tile = parent of `.drop-benefit__image-container`. It holds:
    - the image, whose URL contains a reward UUID
    - the name in a `<p>`
    - the type in `span.tw-pill`

    The only types seen were `In-Game Item` (460) and `Badge` (10).
  - Body sections are labelled by `.drop-details__label > strong`:
    - The first `<strong>` is the campaign title (not unique: The Quinfall has two "November Drops").
    - Then come `Rewards`, `How to Earn the Drop`, `Progress & Redemption`, and optionally `Connection`. Connection shows "(Required)" plus either `Connect` or `Connected`.
  - The redeem line reads `Watch to Redeem` (93), `Subscribe to Redeem` (4), or both (5).
  - **No progress or claimed state appears anywhere on the campaigns page.** The bodies for THE FINALS (in progress) and Enshrouded (fully claimed) look the same as untouched campaigns.
- **Inventory page:**
  - It has its own URL, `/drops/inventory`.
  - **In Progress:**
    - a campaign title linking to `/drops/campaigns?dropID=<uuid>`
    - an end date
    - for each reward, a name, `[role=progressbar][aria-valuenow]` and "N% of X hours"
  - **Claimed:**
    - reward name, a relative time ("1 hour ago", "last month") and the image
    - no game or campaign name
    - paginated with "Load More", and limited to the last six months
    - The capture has the full history: 42 rewards, no "Load More" left.
    - Names repeat (A-Class Multi-Tool ×2, Atlas Firework Pack ×2), so match by image UUID, not by name.
  - The first page shows 20 claims and a "Load More" button.
  - A reward at 100% shows a "Connect" link until the game account is connected, then a "Claim Now" button.
  - Claim times are rounded down ("1 hour ago" means 60–119 minutes). The four Inventory captures agree on this.
  - Reward image UUIDs on the Inventory page match the campaigns page exactly. All 7 in-progress rewards (THE FINALS, Marvel Rivals) and all 6 claimed Enshrouded rewards match. Within one game, recurring campaigns reuse the same images.

## Cases samples can't cover

These need hand-written test fixtures instead:

- **Year rollover:** dates have no year, e.g. `Mon, Dec 28 - Sat, Jan 9`.
- **Two publishers, one game name:** never observed so far.
- **An Open Reward section, and an upcoming campaign:** neither is present in the current samples.
