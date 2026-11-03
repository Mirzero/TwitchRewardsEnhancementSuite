# TRES Drop Campaigns — userscript specification

Write a Tampermonkey userscript that lets the user hide Twitch Drops campaigns they don't care about or have finished. Then they can see only the new and relevant ones on https://www.twitch.tv/drops/campaigns.

This is a from-scratch rewrite. An earlier version (v0.4.0) was installed in Tampermonkey, but its source has been deleted. Its main bugs are listed in §10 so they aren't repeated.

**File name:** the script is always `TRES-DropCampaigns.user.js` in the repository root. Never put the version in the file name.

- Users install the script from the GitHub repo, and Tampermonkey updates it from that same URL (§1). A file name that changed with each version would break updates for everyone.
- Each new version overwrites this one file. Previous versions live in git history.
- The `.user.js` ending lets Tampermonkey offer to install the file when its raw URL is opened.

---

## 0. Workflow

1. Read `samples/samples_readme.md` and every `samples/page_source_*.html` file.
2. Reply with a short **assumptions list**: anything this spec leaves open and how you plan to resolve it. Wait for confirmation before generating the script.
3. Build in stages:
   - **Stage 1:** extraction, data model and the diagnostics subpanel only (no hiding).
   - **Stage 2:** filters, hiding, panel and persistence.
   - **Stage 3:** the rewards loader (§4.5), per-section hidden counts, and styling.
4. **Every time the script is generated or changed, at every stage:**
   1. Write or update the tests for the behaviour that changed (§9).
   2. Run `npm test`.
   3. Report the results.

   Don't stop for review, or call a stage done, while any test fails. If a test can't pass because the spec is wrong or the samples disagree with it, say so; don't weaken the test.

## 1. Metadata

- `@name` Twitch Drops Campaign Filters
- `@namespace` https://github.com/Mirzero/TwitchRewardsEnhancementSuite
- `@version` 0.5.0. The installed version is 0.4.0. After that, bump the patch version for fixes and the minor version for features.
  - **Every change pushed to `main` must bump `@version`.** Tampermonkey only installs an update when the version is higher than the installed one.
  - Pushing to `main` releases the change to every user, so push only after the tests in §9 pass.
- `@homepageURL` https://github.com/Mirzero/TwitchRewardsEnhancementSuite
- `@supportURL` https://github.com/Mirzero/TwitchRewardsEnhancementSuite/issues
- `@updateURL` and `@downloadURL`: both set to https://raw.githubusercontent.com/Mirzero/TwitchRewardsEnhancementSuite/main/TRES-DropCampaigns.user.js
- `@match https://www.twitch.tv/*`. Twitch is a single-page app, so a user who navigates to the drops page from elsewhere on Twitch never triggers a page load (see §6).
- `@grant GM_getValue`, `GM_setValue`
- `@run-at document-idle`

## 2. Page facts

These were checked against the samples captured 2026-11-03.

### 2.1 Campaign list structure

- **English only.** The script recognises sections, the closed watermark, the connection state and the redeem line by their English text.
  - If no `<h4>` matches a known section heading, show a clear warning in the panel: "Unrecognised page. Is Twitch set to English?" Then stop: hide nothing and inject nothing.
  - Diagnostics lists any unrecognised `<h4>` text.
- All campaigns are on one page; none link to separate pages. The Inventory tab is a different route (`/drops/inventory`), and the script must stay inactive there (until §11).
- All campaigns live inside the single `.drops-root__content` element. Ignore everything outside it.
- Campaigns are grouped under `<h4>` section headings, in this order:
  - `Open Reward Campaigns`
  - `Open Drop Campaigns`
  - `Closed Drop Campaigns`

  **Any section can be missing.** The current samples have no Open Reward section. A campaign's type is the nearest preceding `<h4>` in document order. Strip the trailing "s" to get the type name.
- **"Closed" means ended.** All 18 Closed campaigns in the sample had end dates before capture time. Closed campaigns appear lower on the page, under their own heading. Every reward tile in a Closed campaign carries the watermark text `This campaign has closed.`
  - When a campaign ends, Twitch moves it from an Open section to Closed. Its ID must not change when that happens (§3).
- Each campaign looks like this:

  ```
  <div>                                   ← campaign root (exactly 2 children)
    <div class="… accordion-header" role="heading" aria-level="3">
      <button aria-expanded="true|false">
        … <img alt="{Game}" src="{box art}">
        … <p>{Game}</p><p>{Publisher}</p>
        … <div>{date range}</div>
      </button>
    </div>
    <div>…</div>                           ← body
  </div>
  ```

  Concretely:
  - Header selector: `.drops-root__content .accordion-header[role="heading"][aria-level="3"]`
  - Game is the first `<p>` in the header and publisher is the second. All 102 headers have exactly 2. `img[alt]` always equals the game name, so it can serve as a fallback.
  - The date range is the text of the header's leaf `<div>` matching the date pattern in §2.3.
  - Campaign root = `header.parentElement`. Body = `header.nextElementSibling`.
- **How the body behaves:**
  - It is empty until the campaign is first opened.
  - **When the campaign is closed, the content stays.** Twitch only flips `aria-expanded` to `false` and swaps a CSS class.

  So:
  - `aria-expanded` tells you whether the campaign is open now.
  - `body.children.length > 0` tells you whether its content has loaded.
- **Only one campaign can be open at a time.** Opening one closes the others. Rewards become known one campaign at a time, so the script must remember them (§4.5, §5).
- **Do not use obfuscated class names** like `Layout-sc-1xcs6mc-0` or `dvalrg`. They change with every Twitch deploy. Use only these:
  - the stable class names `drops-root__content`, `accordion-header`, `drop-details__label`, `drop-benefit__image-container`, `tw-pill`, `tw-link`
  - ARIA attributes
  - tag structure
  - text content

### 2.2 Campaign body (once loaded)

- The first `<strong>` in the body is the **campaign title**, e.g. `Frozen Trail`. Titles aren't unique: The Quinfall has two campaigns called "November Drops". Next to the title is a redeem line, which reads `Watch to Redeem` (93), `Subscribe to Redeem` (4), or both (5).
- Sections are labelled with `.drop-details__label > strong`:
  - `Rewards`
  - `How to Earn the Drop`: list items like "Watch for 2 hours and claim the reward X" or "Purchase 1 new recurring or gift subscription…".
  - `Progress & Redemption`
  - `Connection`, which is optional and appears in 99 of 102 campaigns. It shows "(Required)" and then either a `Connect` or a `Connected` button.
- **Reward tile** = `container.parentElement` for each `.drop-benefit__image-container`. Inside the tile:
  - image: `img` inside the container. The `src` takes one of three forms:
    - `https://static-cdn.jtvnw.net/twitch-quests-assets/REWARD/{uuid}.png` for most rewards
    - `https://static-cdn.jtvnw.net/badges/v1/{uuid}/…` for some Badge rewards (e.g. QSMP2)
    - `…/REWARD/default.png`, a shared placeholder with no UUID (2 Palia rewards). Its `imageUuid` is null.
  - name: the `<p>` in the tile. It can have trailing spaces, so normalize it.
  - type: `span.tw-pill` in the tile. Types seen: `In-Game Item` (460 tiles) and `Badge` (10). Treat the type as free text; don't hardcode a list.
  - closed watermark: a tile descendant whose text is `This campaign has closed.`
- **Some loaded bodies may have no readable reward tiles.** Open Reward campaigns used a different layout (ball tiles without type pills), and there's no current sample of one.
  - If a loaded body has no `.drop-benefit__image-container`, or any tile lacks a name or a type, set `rewards = null`, meaning unknown.
  - Count these in diagnostics. Never guess.
- One campaign can list the same reward more than once (Overwatch has "Esports Loot Box" three times). Within a game, campaigns can reuse the same image UUID.
- **The campaigns page shows no progress or claimed state.** A finished campaign (Enshrouded) and one in progress (THE FINALS) look the same as untouched campaigns. Claimed state therefore comes from the user marking rewards (§4), and later perhaps from the Inventory page (§11).
- Badge rewards are "automatically claimed", according to the body text.

### 2.3 Dates

- Format: `Ddd, Mmm D, h:mm AM|PM[ TZ] - Ddd, Mmm D, h:mm AM|PM[ TZ]`. For example: `Thu, Oct 8, 4:00 AM - Wed, Nov 4, 5:44 AM PDT`. The start has no timezone in every campaign sampled.
- **Dates are shown in the viewer's browser timezone.** The label matches the viewer's zone: the owner is in America/Vancouver, which is UTC-7 all year, and every label reads `PDT`, even in November. Parse dates as browser-local time. If the label disagrees with the browser's current abbreviation, record that in diagnostics, but don't apply it.
- **There is no year.** Pick the year that puts the start date closest to now (within ±6 months). If the end then falls before the start, add a year to the end.
- Store dates as epoch milliseconds, and keep the original text for display.

### 2.4 Facts from the samples

These are used in the acceptance tests.

- **`page_source_default.html`:** 102 campaigns.
  - 84 Open Drop and 18 Closed Drop. No Open Reward section.
  - 93 distinct games (by game + publisher) and 74 distinct publishers.
  - No game name appears with two different publishers. This case is still allowed and must be handled.
  - 9 games have one Open and one Closed campaign. For example, Overwatch / Blizzard has an Open campaign running Oct 30 – Dec 1 and a Closed one that ran Oct 6 – Nov 3.
  - Game + publisher + date range is unique across all 102 campaigns without the section, so the section isn't needed in the ID.
- **`page_source_opencampaigns.html`:**
  - The same 102 campaigns, all with bodies loaded.
  - 470 reward tiles: 460 `In-Game Item` and 10 `Badge`. Every tile has a name and a type.
  - All 64 tiles in Closed campaigns carry the closed watermark; none in Open campaigns do.
  - Exactly 3 campaigns contain **only** Badge rewards: QSMP, Dead by Daylight and ELDEN RING.
- **Never hardcode campaign counts or reward types.** They change daily.

## 3. Data model

```
Campaign {
  id            // see below
  type          // 'Open Reward Campaign' | 'Open Drop Campaign' | 'Closed Drop Campaign'
  closed        // type is Closed Drop Campaign, or end < now (see §4.1)
  game, publisher
  gameKey       // normalized(game) + '|' + normalized(publisher)
  publisherKey  // normalized(publisher)
  start, end    // epoch ms (null if unparseable)
  dateText      // original header text
  status        // 'upcoming' | 'active' | 'ended', from start/end and now
  title         // from body, else from storage, else null
  redeem        // ['watch'] | ['subscribe'] | both | null if unknown
  connection    // 'connected' | 'required' | 'none' | null if unknown
  rewards       // Reward[] from body or storage; null = unknown
  expanded      // aria-expanded === 'true'
  rootEl        // live DOM reference, never persisted
}

Reward {
  key           // campaign id + '|' + imageUuid + '|' + normalized(name) + '|' + occurrence index
  name, type    // type = pill text, e.g. 'In-Game Item', 'Badge'
  imageUuid
  tileEl        // live DOM reference when the body is loaded, never persisted
}
```

- **Campaign `id`** = `gameKey + '|' + start + '|' + end`, using the parsed epoch milliseconds.
  - If either date fails to parse, use `gameKey + '|' + normalized(dateText)` instead, and count it in diagnostics.
  - The **section is deliberately left out**. Twitch moves a campaign from Open to Closed when it ends, and its hidden state, claimed marks and stored rewards must survive that move.
  - Epoch times are used rather than the date text so that a change in the timezone label can't change the ID.
  - Build the ID **only from header fields**, so it stays the same whether the body is loaded, open or closed, and across page loads.
  - Never include body-derived values or the box-art URL. The box art is the game's image, shared by every campaign of that game.
- **Normalization:** collapse whitespace, trim, apply Unicode NFC, then lowercase. Keep accents.
- A game is identified by `gameKey`. Two games with the same name but different publishers are different games.
- When a body is loaded, extract its title, redeem line, connection state and rewards, and save them to storage under the campaign `id` (§4.5, §5). When a body isn't loaded, use the stored values.

## 4. Filtering and hiding

### 4.1 Rules

A campaign is hidden if **any** rule matches it. Every rule is persisted.

1. **Hide closed campaigns:** an independent toggle that hides every campaign in the Closed section. An Open campaign whose end time passes while the page is open is also treated as closed. **On by default.**
2. **Hide campaign:** a specific campaign `id`.
3. **Hide game:** a `gameKey`. It hides that game's campaigns in **every** section, Open and Closed.
4. **Hide publisher:** a `publisherKey`. It hides all of that publisher's campaigns in **every** section.
5. **Hide upcoming:** campaigns with `status === 'upcoming'`.
6. **All rewards done:** the campaign's rewards are known (not null, not empty), and **every** reward is "done". A reward is done if either:
   - its type is in the hidden reward types (e.g. `Badge`), or
   - it is marked claimed (manually, or later from the Inventory, §11).

   A mix of the two also counts: for example, a campaign whose only rewards are a claimed item and a Badge is hidden when Badge is a hidden type.

**Defaults on first install:** Hide closed is on. Everything else is off or empty: no hidden campaigns, games, publishers or reward types; hide upcoming off; show hidden off.

### 4.2 Controls on the page

- **Campaign header:** inject a small **Hide** button into each `.accordion-header`, **outside** its `<button>`, so clicking it never opens or closes the campaign. It opens a small menu with three choices:
  - Hide this campaign
  - Hide all {Game}
  - Hide all from {Publisher}
- **Reward tiles:** when a body is loaded, add a **"✓ Claimed"** toggle to each reward tile. Dim tiles that are done, and label them "claimed" or "hidden type: Badge".
- Mark every injected element with `data-tres`, and never inject it twice.

### 4.3 Filter panel

**Placement and behaviour:**

- **Position:** a floating panel in the top-right corner, just below Twitch's top navigation bar (about 5rem high). Use `position: fixed`, and keep it above Twitch's content but below Twitch's own menus and modals.
- **Collapsed state:** the default. A small pill shows "TRES · {hidden} hidden". It's a minimal intrusion, and it must not cover any campaign header's controls at widths of 1280px and up.
- **Opening and closing:**
  - Clicking the pill expands the full panel.
  - The panel collapses again when the user clicks anywhere outside it, presses Esc, or clicks its collapse button.
  - It must **not** collapse while one of its inputs has focus, or while the rewards loader is running. While the loader runs, the pill shows its progress.
- **Expanded size:** at most 380px wide and `calc(100vh - 7rem)` tall, scrolling internally. While expanded, it may overlap the page.
- **Style:** match Twitch's dark theme.

**Contents, top to bottom:**

- **Summary line:** "{visible} shown · {hidden} hidden · {total} campaigns ({closed} closed)".
- **Hide closed campaigns:** a prominent standalone toggle, with a count.
- **Hide upcoming**.
- **Show hidden** toggle: hidden campaigns are shown dimmed with a label saying which rule hid them. This mode is for checking the filters.
- **Rewards:**
  - "Rewards known for N / total campaigns".
  - The **Load all rewards** button (§4.5).
  - Reward types: one checkbox per type seen (Badge, In-Game Item, …). Show two counts for each: rewards of that type, and campaigns made up only of that type.
- **Open campaigns** and **Closed campaigns:** two separate groups, so Closed entries don't clutter the Open lists.
  - Each group has a Publishers list and a Games list ("Game — Publisher"). Each entry shows its campaign count in that group and a hide toggle. Each list has a text box that filters it, and is sorted by name.
  - Hide rules apply everywhere (§4.1). So toggling a game or publisher in either group toggles it in both, and the two groups always show the same state.
  - The Closed group starts collapsed.
- **Hidden campaigns:** a list of campaigns hidden by rule 2, each with an "unhide" button. It includes campaigns no longer on the page.
- **Claimed rewards:** the count, plus a "clear claimed marks for campaigns that are no longer listed" button.
- **Backup:** Export and Import buttons, plus "last backup: N days ago" (§5).
- **Reset all** button, which asks for confirmation.
- **Diagnostics** subpanel, collapsed by default (§7).

**Rules for the controls:**

- Controls mean what they say: a checked "Hide" box hides things. Don't use a "checked = visible" design.
- Build all text with `textContent`, never `innerHTML` with page-derived strings.

### 4.4 How hiding works

- Hide the campaign root with a single class: `tres-hidden { display:none !important }`. Use `tres-dimmed` in show-hidden mode.
- If every campaign in a section is hidden, append a note under that section's `<h4>`, such as "18 hidden". Don't hide the `<h4>` itself.

### 4.5 Rewards: learning, storing and loading

**Rewards are learned once per campaign and remembered.**

- Whenever a campaign's body is loaded, whether the user opened it or the loader did, extract its rewards and save them under the campaign `id`, along with `rewardsSeenAt`.
- After that, the campaign never needs to be opened again: rule 6 uses the stored rewards across page loads.

**Twitch can change a campaign after it's been read.** The design handles this as follows:

- **Dates change** (e.g. a campaign is extended): the ID changes, so the campaign looks new, and its rewards are learned again. Hide-by-campaign marks for the old ID stop applying. Hide-by-game, hide-by-publisher and reward-type rules are unaffected.
- **Rewards change but dates don't:** whenever a body is seen, its rewards overwrite the stored copy, and claimed marks follow their reward keys. The panel also offers **"Re-read all rewards"**, a secondary action next to Load all rewards, which runs the loader over every campaign rather than only unknown ones.

**The Load all rewards button:**

- It only ever runs when the user clicks it; it never starts on its own.
- It opens each campaign whose rewards are unknown, one at a time. For each one:
  1. Wait until the body exists and has stopped changing (about 3 identical polls 200ms apart, at most 8s).
  2. Read the body.
  3. Move on to the next campaign.

  The approach is the same as `samples/capture-snippet.js`.
- When it finishes, it restores the campaign that was open before it started (or closes them all) and puts back the page's scroll position.
- It shows progress ("Loading rewards 12 / 40") in the panel and in the collapsed pill, and has a Cancel button. Cancelling keeps everything learned so far.
- Campaigns that time out are counted and listed in diagnostics. They stay unknown.
- Because rewards are stored, later runs only need to cover campaigns that are new since the last run.

## 5. Persistence

**Every manual action must persist:** hidden campaigns, games, publishers and reward types; claimed marks; and the toggles.

**Storage: Tampermonkey storage (`GM_getValue` / `GM_setValue`), plus Export/Import in the panel.** This is the owner's decision.

- Tampermonkey storage survives page reloads, Twitch logouts and clearing Twitch's site data. It's lost only if the script is deleted from Tampermonkey or the browser profile is lost. Export and Import guard against those cases.
- **Export** downloads `tres-drop-campaigns-backup-YYYY-MM-DD.json` and records the time in `lastExportAt`.
- **Import** reads a chosen file and **merges** it with existing data, rather than replacing it:
  - Union of the hide rules.
  - Union of the claimed marks.
  - For stored campaigns, the newer `rewardsSeenAt` wins.
- **Not used:** `localStorage` (it's wiped with site data and other scripts can read it), and cloud sync (not needed for now).

Details:

- Use one GM key: `tresDropCampaigns.v2`. Don't read or migrate the v0.4.0 key (`tesDropCampaignFilters`); its IDs aren't compatible.
- Contents:
  ```
  {
    schema: 2,
    lastExportAt,
    rules: {
      hideClosed: true, hideUpcoming: false, showHidden: false,
      hiddenRewardTypes: [normalized type],
      hiddenCampaigns:  { id: { game, publisher, dateText, title, hiddenAt } },
      hiddenGames:      { gameKey: { game, publisher } },
      hiddenPublishers: { publisherKey: { publisher } }
    },
    claimed:   { rewardKey: { name, campaignId, claimedAt } },
    campaigns: { id: { firstSeen, lastSeen, end, title, redeem, connection, rewardsSeenAt, rewards: [{ key, name, type, imageUuid }] } }
  }
  ```
- If the stored data is missing or unreadable, start from the defaults in §4.1. Never throw.
- Prune `campaigns` and `claimed` entries whose campaign ended more than 60 days ago **and** wasn't seen on the page in that time. Never prune `rules` automatically.
- Write storage only when something changes, not on every scan. Write it in one place, and debounce writes.

## 6. Reactivity and lifecycle

- **Route handling:** run only while `location.pathname` starts with `/drops/campaigns`.
  - Watch for route changes by wrapping `history.pushState` and `history.replaceState` and listening for `popstate`.
  - On entering the page: wait for `.drops-root__content`, then start.
  - On leaving the page: cancel the rewards loader, disconnect observers and remove the panel.
- **Observer:** one `MutationObserver` on `.drops-root__content`, with `{ childList: true, subtree: true }`.
  - Also watch the `aria-expanded` attribute, using `attributeFilter: ['aria-expanded']`.
  - Ignore mutations whose added and removed nodes are all `[data-tres]` elements.
  - Debounce scans by about 150ms.
  - If Twitch replaces the `.drops-root__content` element, find it again and re-attach the observer.
- **Scans must be cheap:**
  - Re-parse only headers whose root changed, or that are new.
  - Read a body only when it goes from empty to filled, or its content changes.
- **Panel updates:**
  - Re-render a list only when its contents (keys or counts) change.
  - Keep scroll position, focus and search-box text.
  - Never rebuild the panel while one of its inputs has focus.
- Updates must not loop forever: hiding or dimming, and injecting buttons, must never trigger another scan.

## 7. Diagnostics subpanel

This subpanel is for checking that extraction works on the live page. It's collapsed by default and shows:

- the number of headers found, compared with the number of campaigns parsed. If they differ, highlight the mismatch.
- any unrecognised `<h4>` text (§2.1)
- counts by section, plus distinct games and publishers, for Open and Closed separately
- rewards known for N / total campaigns, plus:
  - loaded bodies with unreadable rewards
  - loader timeouts
  - a count of reward tiles by type
  - how many tiles have the closed watermark
- the number of dates that failed to parse (and so use the fallback ID), and the number whose timezone label doesn't match
- a list of headers that failed to parse, each with its reason and the first 80 characters of its text
- the time of the last scan and how long it took
- a **"Copy model as JSON"** button, which copies the live model and stored data without DOM references

## 8. Code organization

One file, inside an IIFE, with clearly separated sections in this order:

1. **Constants and utilities:** normalization, date parsing.
2. **Data model:** types, id/key builders.
3. **Extraction:** pure functions taking a root `Element` and `now`, returning plain objects. No globals, and they never write to the DOM.
4. **Filter model and storage:**
   - `hideReason(campaign, rules, claimed) → string | null`
   - `rewardDone(reward, rules, claimed)`
   - `mergeImport(current, imported)`
   - `prune(data, now)`
   - a storage adapter that can be swapped in tests
5. **Rendering:** panel, header and tile controls, applying the hide/dim classes.
6. **Orchestration:** route handling, observer, scan scheduling, rewards loader.

**Testability:** at the end of the file, add the following:

```js
if (typeof module !== 'undefined') module.exports = { extractCampaigns, parseDateRange, hideReason, rewardDone, mergeImport, prune, start, … };
```

- When loaded by Node, don't start automatically. Tests call `start(window, storageAdapter)` themselves.
- Make sure this works without Tampermonkey's `GM_*` functions being defined.

## 9. Tests

Tests live in `tests/*.test.mjs`. They use Node's built-in test runner (`node:test`), with jsdom from `node_modules`. Run them all with `npm test`.

- The tests load `TRES-DropCampaigns.user.js` from the project root.
- For each sample, read `now` from the `captured:` line in the sample's header comment.
- **Run them every time the script is generated or changed (§0).** Add a test for each new behaviour and each bug fixed.

### 9.1 Metadata (`metadata.test.mjs`)

- `@version` is valid SemVer.
- `@updateURL` and `@downloadURL` both equal the raw URL in §1.
- `@match` is `https://www.twitch.tv/*`.

### 9.2 Utilities (`utils.test.mjs`)

- **Normalization:**
  - collapses whitespace and trims trailing spaces in reward names
  - keeps `Pokémon` and `Pokemon` distinct
- **Dates:**
  - a start with no timezone parses as browser-local time
  - a range crossing into the next year: `Mon, Dec 28, 9:00 AM - Sat, Jan 9, 8:59 AM PDT` with now = Dec 30
  - year inference near the ±6-month boundary
  - an unparseable date gives `null`, not an exception

### 9.3 Extraction (`extract.test.mjs`)

**`page_source_default.html`:**

- 102 campaigns parsed, with 0 parse failures and no unrecognised headings.
- Sections: 84 Open Drop and 18 Closed Drop. There is no Open Reward section, and that causes no error.
- 93 distinct gameKeys and 74 publisherKeys. All 102 IDs are unique.
- The first campaign is:
  - Open Drop Campaign, `ARC Raiders` / `Embark Studios`
  - start = Oct 8 2026 04:00 local
  - end = Nov 4 2026 05:44 local
- All 18 Closed campaigns have `end < now`.
- Overwatch / Blizzard has 2 campaigns (one Open, one Closed) with different IDs and the same gameKey.
- No campaign has known rewards (no bodies are loaded).

**`page_source_opencampaigns.html`, `page_source_single_expanded.html` and `page_source_expand_then_collapse.html`:**

- Each produces exactly the same 102 IDs as the default sample.
- `single_expanded`: only ARC Raiders has `expanded === true`.
- `expand_then_collapse`: ARC Raiders has `expanded === false`, yet its rewards still extract as `Mailbox`, `Oxygen Respirator`.

**`page_source_opencampaigns.html`:**

- 470 rewards: 460 `In-Game Item` and 10 `Badge`.
- Enshrouded has the title `Enshrouded Artificer` and 6 rewards, and `connection === 'connected'`.
- ARC Raiders has `connection === 'required'`.
- Closed campaigns have the watermark on all 64 tiles; Open campaigns have it on none.

**Fixtures built in the test by editing a sample's DOM:**

- Moving the ARC Raiders campaign root under the Closed `<h4>` changes its `type`, but **not its `id`**.
- Removing one tile's `span.tw-pill` makes that campaign's `rewards === null`.
- Renaming every `<h4>` to non-English text produces the "unrecognised page" state, with nothing hidden.
- A game name with two publishers produces two gameKeys.

### 9.4 Rules (`rules.test.mjs`)

These use the opencampaigns model.

- **Defaults:** `hideClosed` is on, so exactly the 18 Closed campaigns are hidden and nothing else is.
- **Reward types and claimed marks:**
  - Hiding the reward type `Badge` hides exactly QSMP, Dead by Daylight and ELDEN RING. League of Legends (Badge + In-Game Item) stays visible.
  - Marking all 6 Enshrouded rewards claimed hides Enshrouded. Marking 5 does not.
  - With Badge hidden, marking `Flex On Em` claimed hides League of Legends (the mixed case).
  - A campaign with unknown rewards is never hidden by rule 6.
- **Game and publisher rules apply in every section:**
  - Hiding gameKey `overwatch|blizzard` hides **both** Overwatch campaigns (Open and Closed).
  - Hiding a publisher hides all of its campaigns in every section.
- **Single campaign:** hiding one campaign ID hides exactly one campaign.

### 9.5 Storage (`storage.test.mjs`)

- Missing or corrupt stored data gives the §4.1 defaults, without throwing.
- `mergeImport` takes the union of the rules and claimed marks, and the newer `rewardsSeenAt` wins.
- An export followed by an import into empty storage reproduces the same state.
- `prune` removes campaigns that ended and haven't been seen for more than 60 days, along with their claimed marks, and never touches `rules`.
- Stored rewards are used when a body isn't loaded. Take the default sample (no bodies loaded), stored rewards from the opencampaigns sample, and Enshrouded's 6 rewards marked claimed: rule 6 still hides Enshrouded.

### 9.6 Live script in jsdom (`dom.test.mjs`)

Run `start()` against a sample in jsdom, with an in-memory storage adapter.

- **Hiding:** with the defaults, exactly 18 campaign roots get `tres-hidden`.
- **Header buttons:** exactly one Hide button is injected per header. Running a second scan doesn't duplicate them.
- **No loop:** after a scan, hiding a campaign triggers no further scans.
- **Header button clicks:** clicking the Hide button doesn't change the header button's `aria-expanded`.
- **Panel:** it starts collapsed. Clicking the pill expands it, and a click outside collapses it.
- **Rewards loader:** using a sample whose bodies are already loaded, or a stub that fills a body when a header is clicked, the loader:
  - visits only campaigns whose rewards are unknown
  - stores what it reads
  - can be cancelled midway, keeping what it learned

## 10. Known mistakes to avoid

These are from v0.4.0.

- A hardcoded expected count (`99`). The real count varies daily.
- Putting the end date into a game's ID, so "hide game" only hid one campaign.
- Campaign IDs that included body-derived text, so they changed when a campaign was opened.
- Guessing reward types from a hardcoded word list and `[class*="pill"]`. Use `span.tw-pill` inside a reward tile.
- Adding campaign types to the reward-type list.
- Hiding a whole campaign when **any one** of its rewards matched a filter. The rule is **all** rewards (§4.1, rule 6).
- Detecting "completed" by regex-matching `100%` anywhere in a campaign's text. The campaigns page has no claimed state.
- Re-scanning everything and rebuilding the whole panel on every DOM mutation.
- `@match` limited to the drops URL. It doesn't fire on navigation within the single-page app.

## 11. Deferred: claimed and progress from the Inventory page

This is **not** for this version; it's recorded so the design leaves room for it. `samples/page_source_other_tab.html` is an Inventory capture.

- **In Progress section**, for each campaign:
  - a title link to `/drops/campaigns?dropID={uuid}`
  - an end date
  - for each reward: name, `[role=progressbar][aria-valuenow]`, "N% of X hours", and an image with a REWARD UUID
- **Claimed section**, for each reward:
  - reward name, relative time ("1 hour ago", "last month") and an image with a REWARD UUID
  - no game or campaign
  - paginated with "Load More"; only the last six months are visible
- **Matching:**
  - The reward image UUIDs match the campaigns page exactly. In the 15:09 capture:
    - In Progress: THE FINALS "PRIME TIME" (3 rewards, 7–31%) and Marvel Rivals "Season 10.5 Twitch Drops" (4 rewards, 4–36%). All 7 matched.
    - Claimed: all 6 Enshrouded rewards matched.
  - Claimed rewards from campaigns no longer listed simply don't match. 36 of the 42 in the full history are like that.
  - Reward names repeat in the Claimed list (A-Class Multi-Tool ×2), so match by UUID, never by name.
- **Caveat:** recurring campaigns of the same game (daily Albion Online, Black Desert, the Open and Closed pairs) reuse image UUIDs. A UUID match alone could mark today's drop claimed because of yesterday's claim. Require the claim time to fall after the campaign's start. The relative times are coarse, so treat matches older than about a day as uncertain.
- **Possible approach:**
  1. The script, which matches all of twitch.tv, reads the Inventory when the user visits `/drops/inventory`.
  2. It stores the image UUIDs of claimed rewards, with their approximate times, plus progress per campaign.
  3. The campaigns page then uses that store as an extra source of "claimed" for rule 6, and can show progress badges on headers.

  Manual claimed marks stay as an override.
- Other possible filters later: "hide subscription-only campaigns" (from the redeem line), and "hide campaigns that need an account I haven't connected" (from Connection).

## 12. Deliverables

1. The assumptions list (§0).
2. `TRES-DropCampaigns.user.js`, with `@version` bumped (§1).
3. `tests/*.test.mjs` (§9), plus the output of `npm test` showing every test passing.
4. **Live validation steps.** Write a numbered checklist the owner can follow on the real page. Include the following checks:
   - Compare the diagnostics header count with the campaigns parsed.
   - Spot-check three campaigns against what's on screen.
   - Open and close a campaign, and confirm its ID, rewards and hide state don't change.
   - Confirm Closed campaigns are hidden on first install, then toggle "Hide closed".
   - Check that the collapsed pill doesn't cover any campaign controls, that it expands on click, and that it collapses on an outside click or Esc.
   - Run Load all rewards, then reload and confirm the "rewards known" count stays and a second run has nothing to do.
   - Hide the Badge type and confirm the badge-only campaigns disappear.
   - Mark every reward in a campaign claimed and confirm the campaign hides.
   - Hide a game that has both an Open and a Closed campaign, turn Hide closed off, and confirm both stay hidden.
   - Reload and confirm everything stays hidden.
   - Export, Reset, Import, and confirm the state comes back.
   - Navigate away within Twitch and back, and confirm the panel returns.
   - Toggle "Show hidden" and check that each dimmed campaign's reason is correct.
