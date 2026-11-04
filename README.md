# Twitch Rewards Enhancement Suite (TRES)

A Tampermonkey userscript for Twitch's [Drops campaigns](https://www.twitch.tv/drops/campaigns) page. Twitch lists over a hundred campaigns, most of them for games you don't play or rewards you already have. TRES hides those, so the new and unfinished ones stand out.

---

# For users

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open **[TwitchRewardsEnhancementSuite.user.js](https://raw.githubusercontent.com/Mirzero/TwitchRewardsEnhancementSuite/main/TwitchRewardsEnhancementSuite.user.js)**. Tampermonkey shows an install page; click **Install**.
3. Open https://www.twitch.tv/drops/campaigns. The first time, TRES opens a short introduction in the top-right corner. Click **Got it** to close it.

**Updates** install automatically on Tampermonkey's normal schedule. To check right away, open Tampermonkey's Dashboard → Installed userscripts and click the script's update link.

**Upgrading from "Twitch Drops Campaign Filters":** that was this script's name up to version 0.8.0. Delete it in Tampermonkey, then install from the link above. Otherwise both copies run at once. Likewise, delete any copy you pasted in by hand.

## Getting started

1. **Click the TRES pill** in the top-right corner of the Drops page to open the panel. Click **–** or press Esc to close it again. Clicking elsewhere on the page leaves it open, so you can work with both.
2. **Hide what you don't want.** Each campaign header has a **Hide** button for that campaign, and a **⋯** button for hiding the whole game or everything from that publisher.
3. **Open the Inventory tab once.** TRES reads your claimed rewards and progress there, and uses them on the Campaigns page.
4. **Click ? in the panel** at any time to see the introduction again.

TRES works only with Twitch set to English. On any other language it shows a warning and changes nothing.

## Features

### Hiding campaigns

- **Closed campaigns are hidden** from the start. Turn this off under **Visibility** in the panel.
- **Hide** on a campaign header hides that campaign at once.
- **⋯** hides every campaign for that game, or from that publisher, in both the Open and Closed sections.
- **Games and publishers** can also be hidden from lists in the panel, under **Open campaigns** and **Closed campaigns**. Each list has a search box.
- **Upcoming campaigns** can be hidden with one toggle.
- **Hidden campaigns** in the panel lists everything you hid one by one, with an Unhide button for each.
- Each section heading on the page shows how many of its campaigns are hidden. On the Open section, clicking that count shows the hidden campaigns dimmed, with a label saying why each one is hidden. **Show hidden campaigns (dimmed)** in the panel does the same.

### Rewards

- **✓ Claimed:** each reward in an opened campaign gets a toggle. A campaign hides once every reward in it is claimed.
- **Hide reward types:** for example, hide Badges. A campaign also hides when all of its rewards are claimed or of a hidden type.
- **Load all rewards:** Twitch only shows a campaign's rewards when you open it. This button opens each campaign once, one at a time, and remembers its rewards, so the two rules above work without opening campaigns by hand. You can cancel it at any time. **Re-read all rewards** does the same for every campaign, to pick up changes.

### Inventory: claims and progress

Visit Twitch's **Inventory** tab once and TRES reads what you have claimed and what is in progress. Back on the Campaigns page:

- Rewards you have claimed are ticked automatically ("claimed (Inventory)"), and fully claimed campaigns hide.
- Rewards in progress get a progress bar and a label on their image, such as "36% of 30 minutes" or "Ready to claim".
- Campaign headers show a summary such as "2/5 claimed · 36%". Hover it to see each reward.

On the Inventory tab, the TRES panel has **Scan full history (Load More)**, which loads your whole claim history (Twitch keeps six months). Without it, TRES sees only the claims on the first page.

If TRES marks a reward claimed by mistake, untick it; it stays unticked. With the Campaigns and Inventory tabs open side by side, the Campaigns tab updates as soon as the Inventory changes.

### Sorting

Choose the order of campaigns within each section: newest first (the default), Twitch's own order, ending soonest, game A–Z or publisher A–Z.

### Backup

Settings are kept in Tampermonkey's storage, so they survive reloads, logging out and clearing Twitch's site data. They are lost only if you delete the script or your browser profile. To guard against that:

- **Export** downloads your settings, claimed marks and Inventory data as a JSON file.
- **Import** merges a backup file into your current settings.
- **Reset all** restores the defaults. It asks for confirmation first.

Nothing is sent anywhere. TRES runs only in your browser.

## Problems

- **Nothing is hidden, or the counts look wrong:** open the panel's **Diagnostics** section. If the number of headers found and campaigns parsed differ, Twitch has probably changed its page.
- **Report a bug** on the [issues page](https://github.com/Mirzero/TwitchRewardsEnhancementSuite/issues). **Copy model as JSON** in Diagnostics copies what TRES read from the page, which helps.

---

# For developers

## Development approach

The script isn't written by hand. It's generated by an AI coding assistant from a specification, and the specification is the real source of the project.

- **`prompt.md` is the source of truth.** It holds:
  - what the script must do
  - facts about Twitch's page, checked against real captures
  - the data model and filter rules
  - acceptance tests
  - known mistakes to avoid
  - decisions still open, marked `TODO (owner)`
- **The script is generated output.** If it's wrong, fix `prompt.md` and generate it again. Don't patch the script directly; a fix made only in the script is lost at the next generation.

### The loop

1. **Capture samples.** Twitch builds the page with JavaScript, so "Save Page As" doesn't work. Capture the rendered page with `samples/capture-snippet.js` instead. `samples/samples_readme.md` lists each sample and how to get it.
2. **Analyse the samples.** Check every structural claim, selector, count and edge case against the captures before it goes into `prompt.md`. Don't guess.
3. **Refine `prompt.md`.** Record what was learned, resolve the open TODOs, and update the acceptance tests to match.
4. **Generate in stages**, as `prompt.md` §0 describes:
   1. The assistant lists its assumptions first.
   2. Then it builds extraction, then filters, then polish, stopping for review after each stage.
5. **Test.** Run the tests against the samples with `npm test` every time the script is generated, then follow the live validation checklist on Twitch.
6. **Feed back.** Turn any failure or surprise into a spec change, plus a new sample if needed, then go back to step 3.

When Twitch changes its markup, start again at step 1. Re-capture the samples, compare them with the old ones, and update `prompt.md`.

## Layout

| Path | Purpose |
|---|---|
| `prompt.md` | The specification the script is generated from. |
| `samples/` | Captured page snapshots, the capture helper, and `samples_readme.md`. |
| `tests/` | Acceptance tests (generated, run with Node + jsdom). |
| `TwitchRewardsEnhancementSuite.user.js` | The generated script. Its file name never changes, because Tampermonkey checks this URL for updates. |

## Setup

```sh
npm install                      # installs jsdom for the tests
npm test                         # runs node --test on tests/*.test.mjs
```

## Releasing

Pushing to `main` releases the script to everyone who installed it. So before each push:

1. Bump `@version` in the script. Tampermonkey ignores updates that don't raise the version.
2. Make sure `npm test` passes.
