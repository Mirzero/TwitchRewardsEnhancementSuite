# Twitch Rewards Enhancement Suite (TRES) — userscript specification

Write a Tampermonkey userscript, **Twitch Rewards Enhancement Suite**, for Twitch's Drops pages. On https://www.twitch.tv/drops/campaigns it lets the user hide campaigns they don't care about or have finished, so they see only the new and relevant ones. It is one script for all of TRES's Twitch pages: the Inventory tab (§11) is handled by this same script, so both features share one storage and one install.

This is a from-scratch rewrite. An earlier version (v0.4.0) was installed in Tampermonkey, but its source has been deleted. Its main bugs are listed in §10 so they aren't repeated.

**File name:** the script is always `TwitchRewardsEnhancementSuite.user.js` in the repository root. Never put the version in the file name.

- Users install the script from the GitHub repo, and Tampermonkey updates it from that same URL (§1). A file name that changed with each version would break updates for everyone.
- Each new version overwrites this one file. Previous versions live in git history.
- The `.user.js` ending lets Tampermonkey offer to install the file when its raw URL is opened.
- (Up to 0.8.0 the file was `TRES-DropCampaigns.user.js`, with `@name` "Twitch Drops Campaign Filters". At 0.9.0 it was renamed once, deliberately, when it grew beyond the campaigns page. Only the owner had it installed and reinstalled from the new URL. Don't rename it again.)

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

- `@name` Twitch Rewards Enhancement Suite
- `@namespace` https://github.com/Mirzero/TwitchRewardsEnhancementSuite
- `@version`: the first repo release is **0.6.0**. It skips 0.5.0 because Stage 1/2 builds at 0.5.0 were pasted into Tampermonkey by hand, and Tampermonkey only updates to a higher version. After that, bump once per release: the minor version for features, the patch version for fixes (see `agents/agents.md` for the exact rule).
  - **1.0.0** is the first stable release (the owner's call): Campaigns filters, the Inventory reader and the introduction. It replaced the unreleased 0.10.0. From here, the same rule applies (1.0.0 → 1.1.0 for features, → 1.0.1 for fixes); a major bump only when the owner asks.
  - **Every change pushed to `main` must bump `@version`.** Tampermonkey only installs an update when the version is higher than the installed one.
  - Pushing to `main` releases the change to every user, so push only after the tests in §9 pass.
- `@homepageURL` https://github.com/Mirzero/TwitchRewardsEnhancementSuite
- `@supportURL` https://github.com/Mirzero/TwitchRewardsEnhancementSuite/issues
- `@updateURL` and `@downloadURL`: both set to https://raw.githubusercontent.com/Mirzero/TwitchRewardsEnhancementSuite/main/TwitchRewardsEnhancementSuite.user.js
- `@match https://www.twitch.tv/*`. Twitch is a single-page app, so a user who navigates to the drops page from elsewhere on Twitch never triggers a page load (see §6).
- `@grant GM_getValue`, `GM_setValue`, `GM_addValueChangeListener`, `GM_removeValueChangeListener` (the last two for live sync between tabs, §11.2)
- `@run-at document-idle`

## 2. Page facts

These were checked against the samples captured 2026-11-03.

### 2.1 Campaign list structure

- **English only.** The script recognises sections, the closed watermark, the connection state and the redeem line by their English text.
  - If no `<h4>` matches a known section heading, show a clear warning in the panel: "Unrecognised page. Is Twitch set to English?" Then stop: hide nothing and inject nothing.
  - Diagnostics lists any unrecognised `<h4>` text.
- All campaigns are on one page; none link to separate pages. The Inventory tab is a different route (`/drops/inventory`). The campaign features stay inactive there, and the Inventory reader (§11) runs instead.
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
  - **Order:** within each section, Twitch lists campaigns by **start date, oldest first**. All 84 Open and all 18 Closed campaigns follow it. End dates are in no particular order.
  - **Containers:** each section's campaign roots are the **only children of a single container element**. There is one container per section, holding nothing else. This is what makes sorting with CSS safe (§4.6).
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

**Defaults on first install:** Hide closed is on, and sorting is "Newest first" (§4.6). Everything else is off or empty: no hidden campaigns, games, publishers or reward types; hide upcoming off; show hidden off.

### 4.2 Controls on the page

- **Campaign header:** inject two small buttons into each `.accordion-header`, **outside** its `<button>`, so clicking them never opens or closes the campaign:
  - **Hide** hides **just this campaign, immediately**, with no menu (rule 2). If the campaign is already hidden by rule 2, which can only be seen in show-hidden mode, the button reads **Unhide** and unhides it.
  - **⋯** opens a small menu with the wider options, each labelled Hide or Unhide to match its current state:
    - Hide all {Game}
    - Hide all from {Publisher}
  - (An earlier version had a single "Hide ▾" button whose menu also held "Hide this campaign". The owner split it so the common action takes one click.)
  - Place the buttons together in the header's **top-right corner** (about 3px from the top and right edges), small (11px text, 16px tall) and slightly faded until hovered.
  - They must not sit over the date text or the expand chevron. (An earlier version centred the button vertically beside the chevron, and it covered both.)
  - In show-hidden mode, the "hidden: {reason}" label sits beside them.
- **Reward tiles:** when a body is loaded, add a **"✓ Claimed"** toggle to each reward tile. Dim tiles that are done, and label them "claimed" or "hidden type: Badge".
- Mark every injected element with `data-tres`, and never inject it twice.

### 4.3 Filter panel

**Placement and behaviour:**

- **Position:** a floating panel in the top-right corner, just below Twitch's top navigation bar (about 5rem high). Use `position: fixed`, and keep it above Twitch's content but below Twitch's own menus and modals.
- **Collapsed state:** the default, except on the very first run, when the panel opens on the introduction (§4.8). A small pill shows "TRES · {hidden} hidden". It's a minimal intrusion, and it must not cover any campaign header's controls at widths of 1280px and up.
- **Opening and closing:**
  - Clicking the pill expands the full panel.
  - It collapses **only** when the user clicks its collapse button ("–") or presses Esc.
  - The expanded panel's title row has two buttons in its top-right corner: **?** (reopens the introduction, §4.8) and then "–".
  - **Clicks outside the panel never collapse it**, whether on Twitch's page, on the TRES header buttons or pills, or anywhere else, so the user can work the page with the panel open. (An earlier version also collapsed on any outside click; the owner removed that.)
  - While the rewards loader runs, the collapsed pill shows its progress.
- **Expanded size:** at most 380px wide and `calc(100vh - 7rem)` tall, scrolling internally. While expanded, it may overlap the page.
- **Style:** match Twitch's dark theme, with the TRES brand border (§4.7).

**Contents, top to bottom.** Below the summary line, **every section is collapsible** (a `<details>` with its title as the `<summary>`). **Every section starts collapsed**, so the expanded panel opens as a compact list of section titles and the user opens only what they need.

- **Summary line:** "{visible} shown · {hidden} hidden · {total} campaigns ({closed} closed)". Not collapsible.
- **Visibility:**
  - **Hide closed campaigns:** a prominent toggle, with the count of closed campaigns beside it.
  - **Hide upcoming**, with the count of upcoming campaigns.
  - **Show hidden campaigns (dimmed)**, with the count of hidden campaigns (for any reason, the same number as on the pill). Hidden campaigns are shown dimmed with a label saying which rule hid them. This mode is for checking the filters.
- **Sorting:** one radio button per sort order in §4.6, with the current order selected.
- **Rewards:**
  - "Rewards known for N / total campaigns".
  - The **Load all rewards**, **Re-read all rewards** and **Cancel** buttons, plus a status line (§4.5).
  - Reward types: one checkbox per type seen (Badge, In-Game Item, …). Show two counts for each: rewards of that type, and campaigns made up only of that type.
- **Open campaigns** and **Closed campaigns:** two separate groups, so Closed entries don't clutter the Open lists.
  - Each group has a Publishers list and a Games list ("Game — Publisher"). Each entry shows its campaign count in that group and a hide toggle. Each list has a text box that filters it, and is sorted by name.
  - Hide rules apply everywhere (§4.1). So toggling a game or publisher in either group toggles it in both, and the two groups always show the same state.
- **Hidden campaigns:** a list of campaigns hidden by rule 2, each with an "unhide" button. It includes campaigns no longer on the page.
- **Claimed rewards:** the count, plus a "clear claimed marks for campaigns that are no longer listed" button.
- **Inventory** (§11.5).
- **Backup:**
  - Export and Import buttons, plus "last backup: N days ago" (§5).
  - A **Reset all** button, which asks for confirmation. It resets the hide rules and toggles to the §4.1 defaults and clears claimed marks, but **keeps learned rewards**, since those are a cache, not settings.
- **Diagnostics** (§7).

**Rules for the controls:**

- Controls mean what they say: a checked "Hide" box hides things. Don't use a "checked = visible" design.
- Build all text with `textContent`, never `innerHTML` with page-derived strings.

### 4.4 How hiding works

- Hide the campaign root with a single class: `tres-hidden { display:none !important }`. Use `tres-dimmed` in show-hidden mode.
- **Hidden counter beside each section heading:** whenever at least one campaign in a section is hidden (for any reason, including in show-hidden mode), show a small pill reading "{N} hidden" beside that section's `<h4>`, e.g. "Open Drop Campaigns  [3 hidden]". Its tooltip reads "{N} of {total} campaigns in this section are hidden". Remove the counter when nothing in the section is hidden. Never hide the `<h4>` itself.
  - Insert the counter as the `<h4>`'s **next sibling**, never inside it. The extractor reads the heading's text to recognise the section (§2.1), so text added inside it would break recognition.
  - To put the counter on the same line, give the `<h4>` the class `tres-counted` (`display:inline-block`), and remove the class when the counter goes.
  - (This replaced an earlier note under the heading that appeared only when every campaign in the section was hidden.)
- **The counter reflects show-hidden mode:** it reads "{N} hidden" normally and "{N} dimmed" while "Show hidden campaigns (dimmed)" is on.
- **On Open sections (Open Drop, Open Reward) the counter is a button** that toggles "Show hidden campaigns (dimmed)", the same global setting as the panel checkbox, which follows it.
  - Its tooltip says what a click does ("Click to show them dimmed" / "Click to hide them again"), and `aria-pressed` reflects the state.
  - Clicks are handled in the capture phase like the header buttons, so they never reach Twitch.
  - The Closed section's counter stays a plain, non-clickable counter, though its text still follows the mode.
  - (The owner considered per-section Show/Hide/Dimmed controls for Open, Closed and Upcoming, then dropped them. Upcoming campaigns sit under Twitch's Open heading, and "hide all open campaigns" means nothing useful, so per-section modes would conflict. The single global toggle is deliberate.)

### 4.5 Rewards: learning, storing and loading

**Rewards are learned once per campaign and remembered.**

- Whenever a campaign's body is loaded, whether the user opened it or the loader did, extract its rewards and save them under the campaign `id`, along with `rewardsSeenAt`.
- After that, the campaign never needs to be opened again: rule 6 uses the stored rewards across page loads.

**Twitch can change a campaign after it's been read.** The design handles this as follows:

- **Dates change** (e.g. a campaign is extended): the ID changes, so the campaign looks new, and its rewards are learned again. Hide-by-campaign marks for the old ID stop applying. Hide-by-game, hide-by-publisher and reward-type rules are unaffected.
- **Rewards change but dates don't:** whenever a body is seen, its rewards overwrite the stored copy, and claimed marks follow their reward keys. The panel also offers **"Re-read all rewards"**, a secondary action next to Load all rewards, which runs the loader over every campaign rather than only unknown ones.

**The Load all rewards button:**

- Its label shows how many campaigns it will open, e.g. "Load all rewards (40)". When every campaign's rewards are known, it reads "All rewards known" and is disabled. "Re-read all rewards (102)" shows its count the same way.
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

### 4.6 Sorting

The user can choose the order of campaigns **within each section**. Open and Closed stay separate, and the sections themselves stay in Twitch's order.

| Option (`rules.sortBy`) | Label | Order |
|---|---|---|
| `newest` *(default)* | Newest first | Start date, latest first |
| `twitch` | Twitch order (oldest first) | Twitch's own DOM order, which is start date, oldest first (§2.4) |
| `ending` | Ending soonest | End date, earliest first |
| `game` | Game A–Z | Game name, then publisher |
| `publisher` | Publisher A–Z | Publisher, then game name |

- **Visibility first, then the sort option.** While "Show hidden campaigns (dimmed)" is on, each section becomes two groups: visible campaigns first, then dimmed ones. Each group is ordered by the chosen option. (`displayOrder(campaigns, sortBy, isDimmed)` is a pure function exported for tests.)
  - This applies to "Twitch order" too: while anything in a section is dimmed, that section is reordered so the dimmed campaigns sink to the bottom, with both groups in Twitch's order. When nothing in a section is dimmed, Twitch order removes all of TRES's ordering from it, as before.
  - Fully hidden campaigns (`display:none`) don't affect what you see, so with show-hidden off the plain sort applies.
- **Ties and missing values:** break ties by Twitch's order, so sorting is stable. A campaign whose dates didn't parse sorts after the dated ones. Compare names with `localeCompare`, ignoring case.
- **Sort visually, never move elements.** Moving Twitch's nodes would conflict with how Twitch's own code manages the page, which could undo the order or break opening and closing. Instead:
  - Give each section's container (the shared parent of its campaign roots, §2.4) the class `tres-sorted`, styled `display:flex; flex-direction:column`.
  - Set each campaign root's `style.order` to its sorted position.
  - For `twitch`, remove the class and the `order` values, leaving the page exactly as Twitch rendered it.
  - Mark nothing with `data-tres` for this; it's a class and a style on existing elements. Neither is an observed attribute, so applying the order never triggers a scan.
- **When to apply:** re-apply the order whenever rules are applied (after each scan and each change of setting), so new campaigns and re-rendered sections are sorted too.
- **Known side effect:** keyboard Tab order and screen readers still follow Twitch's DOM order, not the visual order.
- **Cleanup:** when the script stops (leaving the page, or "unrecognised page"), remove `tres-sorted` and every `order` value it set.

### 4.7 Branding

Everything TRES injects into Twitch's page is visibly TRES's, never bare text that looks like part of Twitch.

- **Brand colour:** `#99FF33`, defined once as a constant (`BRAND_COLOR`) and used for the 1px border of every injected element.
- **Small injected elements are pills** (`border-radius: 999px`) with the brand border:
  - the collapsed panel pill ("TRES · N hidden")
  - the section hidden counters beside Twitch's headings (§4.4)
  - the header **Hide** and **⋯** buttons, and the "hidden: {reason}" label (§4.2)
  - the reward tiles' **Claimed** toggle and "hidden type: …" note (§4.2)
- **Larger containers keep their rounded-rectangle shape** but use the brand border: the expanded panel and the ⋯ menu.
- **Only the border is branded.** Backgrounds, text colours, fonts and the contents of the expanded panel stay as they are.
- Hover states change opacity only, never the border colour, so the brand colour is always visible.
- Any new injected element must follow these rules.

### 4.8 Introduction

A short introduction that tells a new user what TRES does and where to find it.

- **First run:** the first time the panel is created, on either the Campaigns or the Inventory page, it opens **expanded on the introduction** instead of collapsed. The panel gets `data-intro="true"`, and everything in its body except the title row and the introduction is hidden (by CSS, so the sections keep their own `hidden` state).
- **Contents** (the same on both pages; `INTRO_LINES`): a "Welcome to TRES (Twitch Rewards Enhancement Suite)" title, then four short points:
  1. TRES hides Drops campaigns you don't need; closed campaigns are hidden from the start.
  2. The Hide and ⋯ buttons on each campaign header.
  3. ✓ Claimed, or opening the Inventory tab once; a campaign hides once all its rewards are claimed.
  4. The TRES pill holds filters, sorting, Load all rewards and Backup, and ? shows this again.

  Then a **Got it** button.
- **Closing it:**
  - **Got it** on the first-run introduction collapses the panel to the pill.
  - "–" or Esc while the introduction shows also closes it and collapses the panel.
  - Either way, the time is saved under its own GM key, `tresIntro.v1`, and the introduction never opens on its own again, on either page. Clicks outside the panel don't close it (§4.3).
  - It has its own key, not a settings field, because the Inventory page never writes the settings (§11.2) and a Campaigns tab open alongside would save its copy over the change.
  - Reset all, Export and Import leave it alone.
- **Reopening:** the **?** button in the expanded panel's title row, beside "–", shows the introduction again. **Got it** then returns to the expanded panel instead of collapsing it.
- The title uses its own class (`tres-intro-title`), not `tres-summary`, which is the panel's summary line.

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

- Settings use one GM key: `tresDropCampaigns.v2`. The Inventory snapshot has its own key (§11.6), and so does the time the introduction was closed (`tresIntro.v1`, §4.8). Don't read or migrate the v0.4.0 key (`tesDropCampaignFilters`); its IDs aren't compatible.
- Contents:
  ```
  {
    schema: 2,
    lastExportAt,
    rules: {
      hideClosed: true, hideUpcoming: false, showHidden: false,
      sortBy: 'newest',            // one of the §4.6 options; anything else falls back to 'newest'
      hiddenRewardTypes: [normalized type],
      hiddenCampaigns:  { id: { game, publisher, dateText, title, hiddenAt } },
      hiddenGames:      { gameKey: { game, publisher } },
      hiddenPublishers: { publisherKey: { publisher } }
    },
    claimed:   { rewardKey: { name, campaignId, claimedAt } },
    inventoryOverrides: { rewardKey: { at, campaignId } },   // §11.4
    campaigns: { id: { firstSeen, lastSeen, end, title, redeem, connection, rewardsSeenAt, rewards: [{ key, name, type, imageUuid }] } }
  }
  ```
- If the stored data is missing or unreadable, start from the defaults in §4.1. Never throw.
- Prune `campaigns` and `claimed` entries whose campaign ended more than 60 days ago **and** wasn't seen on the page in that time. Never prune `rules` automatically.
- Write storage only when something changes, not on every scan. Write it in one place, and debounce writes.

## 6. Reactivity and lifecycle

- **Route handling:** the campaign features run only while `location.pathname` starts with `/drops/campaigns`; the Inventory reader (§11.2) only while it starts with `/drops/inventory`. Each has its own app object, and `start()` routes both.
  - Watch for route changes by wrapping `history.pushState` and `history.replaceState` and listening for `popstate`, plus a 1-second poll as a fallback.
  - On a route change, the page being left is torn down before the next one starts, so there is only ever one `#tres-panel`.
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

- When loaded by Node, don't start automatically. Tests call `start(window, storageAdapter, options)` themselves.
  - `options.now`: a function returning the current time. The live script uses `Date.now`; tests pass the sample's capture time.
  - `options.loaderPollMs`: shortens the polling interval of the rewards loader and of Scan full history in tests.
  - `start()` returns `{ app, inventory, stop }`: the Campaigns app, the Inventory app, and teardown.
- The storage adapter has `read`/`write` for settings, `readInventory`/`writeInventory`/`watchInventory(callback)` for the snapshot, and `readIntro`/`writeIntro` for the introduction (null until it is closed). `memoryStorage(settings, snapshot, introAt = 0)` is the test adapter; two windows sharing one behave like two tabs. Its `introAt` defaults to a returning user, so tests start with the panel collapsed; pass `null` for a first run.
- Make sure this works without Tampermonkey's `GM_*` functions being defined.

## 9. Tests

Tests live in `tests/*.test.mjs`. They use Node's built-in test runner (`node:test`), with jsdom from `node_modules`. Run them all with `npm test`.

- The tests load `TwitchRewardsEnhancementSuite.user.js` from the project root.
- For each sample, read `now` from the `captured:` line in the sample's header comment. This includes the tests that run the whole script (§9.6): they must pass `options.now`, never the real clock. Otherwise results change as real campaigns end; this broke 4 tests the day after the samples were captured.
- Pin the timezone to the capture offset: set `process.env.TZ = 'Etc/GMT+7'` before any `Date` is created. Node's own timezone data can disagree with the browser that captured the samples.
- **Run them every time the script is generated or changed (§0).** Add a test for each new behaviour and each bug fixed.

### 9.1 Metadata (`metadata.test.mjs`)

- `@version` is valid SemVer.
- `@updateURL` and `@downloadURL` both equal the raw URL in §1.
- `@match` is `https://www.twitch.tv/*`.
- `@grant` lists exactly the four GM calls in §1.

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
- **Sorting (`sortCampaigns`, a pure function exported for tests):**
  - `twitch` keeps the extracted order.
  - `newest` puts the latest start first: Rise Online is first among Open campaigns in the default sample (Tue, Nov 3, 10:59 AM).
  - `ending` puts the earliest end first.
  - `game` and `publisher` are alphabetical, ignoring case.
  - Ties keep Twitch's order, and undated campaigns go last.
  - `displayOrder` puts visible campaigns before dimmed ones, each group in sort order (including `twitch`). With nothing dimmed, it equals the plain sort.

### 9.5 Storage (`storage.test.mjs`)

- Missing or corrupt stored data gives the §4.1 defaults, without throwing.
- `mergeImport` takes the union of the rules and claimed marks, and the newer `rewardsSeenAt` wins.
- An export followed by an import into empty storage reproduces the same state.
- `prune` removes campaigns that ended and haven't been seen for more than 60 days, along with their claimed marks, and never touches `rules`.
- Stored rewards are used when a body isn't loaded. Take the default sample (no bodies loaded), stored rewards from the opencampaigns sample, and Enshrouded's 6 rewards marked claimed: rule 6 still hides Enshrouded.

### 9.6 Live script in jsdom (`dom.test.mjs`)

Run `start()` against a sample in jsdom, with an in-memory storage adapter.

- **Hiding:** with the defaults, exactly 18 campaign roots get `tres-hidden`.
- **Branding:** reading the injected stylesheet, every pill element in §4.7 has `border:1px solid #99ff33` and `border-radius:999px`, and the expanded panel and the ⋯ menu have the brand border. Every `tres-` class on an injected element is covered by one of those rules.
- **Section counters:**
  - With the defaults, only "Closed Drop Campaigns" has a counter, reading "18 hidden".
  - Hiding one Open campaign adds "1 hidden" beside "Open Drop Campaigns"; unhiding it removes that counter and the heading's `tres-counted` class.
  - The counter stays in show-hidden mode and reads "dimmed".
  - Clicking the Open counter turns show-hidden mode on (the panel checkbox follows, the counters read "dimmed", and nothing in Twitch toggles); clicking again turns it off. The Closed counter is not a button.
  - A full rescan with counters present still recognises every heading.
  - Leaving the page removes all counters.
- **Header buttons:** exactly one Hide button and one ⋯ button are injected per header. Running a second scan doesn't duplicate them.
- **No loop:** after a scan, hiding a campaign triggers no further scans.
- **Header button clicks:** clicking Hide or ⋯ doesn't change the header button's `aria-expanded`, and neither click reaches the page.
- **Hide acts at once:** clicking Hide hides that campaign without opening a menu. In show-hidden mode it then reads Unhide and reverses it.
- **⋯ menu:** it offers exactly "Hide all {Game}" and "Hide all from {Publisher}", or their Unhide forms.
- **Panel:**
  - It starts collapsed, and every section inside it starts collapsed.
  - Clicking the pill expands it.
  - Clicks outside it, including on Twitch's content and the TRES header buttons, leave it open.
  - The "–" button and Esc collapse it.
- **Introduction (§4.8):**
  - On a first run (`introAt` null), the panel opens expanded on the introduction, which mentions Hide, the Inventory tab and ?. Outside clicks leave it open.
  - Got it collapses the panel and records the time; the next load, on either page, starts collapsed.
  - "–" and Esc on the first-run introduction also record it; the pill then opens the normal panel.
  - For a returning user, ? sits immediately before "–", reopens the introduction, and Got it returns to the expanded panel. The Inventory panel has ? too.
- **Rewards loader:** using a sample whose bodies are already loaded, or a stub that fills a body when a header is clicked, the loader:
  - visits only campaigns whose rewards are unknown
  - stores what it reads
  - can be cancelled midway, keeping what it learned
- **Sorting:**
  - With the default "Newest first", each section's container has `tres-sorted`, and its campaigns' `style.order` values follow `sortCampaigns`.
  - No element is moved: the DOM order of campaign roots is unchanged.
  - Switching to "Twitch order" removes the class and every `order` value.
  - The choice survives a restart.
  - **Dimmed campaigns sink to the bottom:**
    - With Rise Online and ARC Raiders hidden and show-hidden on, they are the last two in the Open section (newest first), and the rest keep newest-first order. With show-hidden off, the plain sort applies.
    - Under "Twitch order", a hidden but not dimmed campaign leaves the section untouched. Dimming it moves it to the bottom, with the rest in Twitch order. Turning show-hidden off removes the ordering again.
- **Routes:** on `/drops/inventory`, only the Inventory panel exists and nothing is injected into the content; navigating to Campaigns swaps in the Campaigns panel; leaving both removes everything.
- `withScript` and `click` live in `helpers.mjs`, shared with `inventory.test.mjs`.

### 9.7 Inventory (`inventory.test.mjs`)

The tests listed in §11.7.

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

## 11. Inventory: claimed rewards and progress

The same script reads Twitch's **Inventory** tab (`/drops/inventory`) and uses what it finds on the Campaigns page. **Status: built in 0.9.0.** Tests: `tests/inventory.test.mjs`.

### 11.1 Inventory page facts

These come from four Inventory captures on 2026-11-03, America/Vancouver:

| Sample | Time | State |
|---|---|---|
| `page_source_other_tab.html` | 15:09 | Full history (Load More clicked until gone): 42 claims, 2 In Progress groups. |
| `page_source_inventory_default.html` | 18:44 | First page only: 20 claims plus Load More. 3 groups, including a reward at 100% whose account wasn't connected yet. |
| `page_source_inventory_just_claimed.html` | 20:34 | 4 Cyberpunk 2077 rewards claimed "32 minutes ago"; their group has left In Progress. |
| `page_source_inventory_claimable.html` | 21:25 | After connecting the THE FINALS account: 2 rewards show **Claim Now**. |


- **Route:** `/drops/inventory`. The page also renders inside `.drops-root__content`, with the stable classes `inventory-page`, `inventory-campaign-info`, `inventory-boxart`, `inventory-drop-image`, `tw-progress-bar` and several `data-test-selector="DropsCampaignInProgressDescription-…"` attributes. Prefer these, plus ARIA attributes and text. Never use obfuscated class names.
- **In Progress** section, one block per drop group:
  - `.inventory-campaign-info` holds:
    - a title link `a[href*="/drops/campaigns?dropID={uuid}"]` (e.g. "PRIME TIME")
    - an end date ("End Date: Thu, Nov 5, 2:29 AM PDT")
    - the box art `img.inventory-boxart`
    - Connect / About This Drop buttons
  - Each reward has:
    - its name in a `<p>`
    - an `img.inventory-drop-image` (alt "Reward Image Icon") whose `src` holds the REWARD UUID
    - `[role="progressbar"][aria-valuenow]` (0–100)
    - a caption `<p><span>{N}</span>% of {duration}</p>` (e.g. "36% of 30 minutes", "7% of 4 hours", "100% of 1 hour")
  - **A reward is in one of three states**, plus a fallback. Find the reward's container by walking up from its image until it also contains the progress bar:
    - **progress:** below 100%. The image also has the class `inventory-opacity-2` (dimmed).
    - **connect:** 100%, but the game account isn't connected. A "Connect" link (`<a>`, text "Connect") sits over the image. Seen for THE FINALS at 18:44.
    - **claimable:** 100%, with a "Claim Now" `<button>` over the image. The name, bar (at 100) and caption stay. Seen at 21:25, after the account was connected.
    - **complete** (fallback, not seen): 100% with neither a Connect link nor a Claim Now button.
  - The group's container is the nearest ancestor of `.inventory-campaign-info` that also holds reward images (alt "Reward Image Icon"). If that ancestor holds more than one `.inventory-campaign-info`, the group has no rewards of its own.
  - **A drop group isn't a whole campaign.** Both its end date and its reward list can differ from the campaign card:
    - Marvel Rivals' card runs to Nov 15 with 9 rewards. Its group "Season 10.5 Twitch Drops" holds the 4 Angela rewards and ends Nov 6.
    - Cyberpunk 2077's card "Quadra Paintjobs" has 5 rewards; the group of the same name had 4.

    **Never match by end date or by reward count.**
  - When all of a group's rewards are claimed, the group leaves In Progress.
- **Claimed** section (heading `<h5>` "Claimed"), one entry per claimed reward, newest first:
  - an `img.inventory-drop-image` with alt "Drop image for {name}" and a REWARD UUID in its `src`. Take the name from the alt text.
  - the reward name in a `<p>`, and the time in the first other non-empty `<p>` of the entry. Find it by walking up from the image, stopping before an ancestor that holds more than one claim image.
  - a relative time in a `<p>`. Forms seen: "32 minutes ago", "1 hour ago" (singular), "N hours ago" (up to 11), "21 days ago", "last month", "N months ago" (2–6). "just now", seconds and "yesterday" haven't been seen.
  - **Twitch rounds the elapsed time down.** The same claims, seen in all four captures, give consistent windows only when "N hours ago" means N ≤ elapsed < N+1 hours. For example, Road Scar was "32 minutes ago" at 20:34 and "1 hour ago" at 21:25 (83 minutes).
  - a quantity, and a disabled "Awarded Drop Connect Button"
  - **No game, campaign or drop ID.** Names repeat (A-Class Multi-Tool ×2), so match by UUID, never by name.
  - **Paginated:**
    - The first page lists **20** claims, followed by a plain `<button>` whose text is "Load More". It has no aria-label or test selector, so find it by its text.
    - Each click adds more. When the history is exhausted the button is gone (the 15:09 capture: 42 claims, no button).
    - Only the last six months are listed.
- A third section, "Rewards" (`<h4>`, e.g. "Sierra Helmet · Code · Redeem"), belongs to Open Reward campaigns. Ignore it.

### 11.2 Reading the Inventory

- **Route handling (§6)** gains a second route. On `/drops/inventory`, start the Inventory reader. When leaving, stop it.
- **On arrival, and after each DOM change** under `.drops-root__content` (child list, text, and `aria-valuenow`; debounced like §6), read what the page shows and save a snapshot:
  ```
  inventory: {
    readAt,                         // epoch ms of this read
    complete,                       // true if no Load More is left (the full six months were read)
    schema: 1,
    inProgress: [ { dropId, title, endText, rewards: [ { name, imageUuid, percent, requiredText, state } ] } ],   // state: 'progress' | 'connect' | 'claimable' | 'complete'
    claims:     [ { name, imageUuid, timeText, earliest, latest } ]   // absolute window for the relative time
  }
  ```
  Each read **replaces** the previous snapshot. It isn't merged, because the page is the source of truth.
  - **Save only a fully rendered page:** don't save until the `<h5>` "Claimed" heading is present. Before that, the list is still loading, and with no Load More button the snapshot would wrongly say `complete: true`.
  - Save when the content changed, or when the last save is at least a minute old (so "last read" stays honest). Don't save on every read.
  - **A claim's window is fixed when its time text is first seen.** Twitch doesn't re-render "5 minutes ago" while the page stays open, so measuring from each later read would shift the window. Cache the window per claim image element (a `WeakMap`) together with its text, and recompute only when the text changes.
  - The Inventory page never writes the settings key; only the snapshot key.
- **Relative times become an absolute window**, measured from `readAt`. Twitch rounds down (§11.1), so a unit count N means [N, N+1) units elapsed. The singular form ("1 hour ago") is accepted for every unit, and so are "a minute ago" and "an hour ago".
  - "N minutes ago" → [readAt − (N+1) min, readAt − N min]
  - "N hours ago" → [readAt − (N+1) h, readAt − N h]
  - "N days ago" → [readAt − (N+1) d, readAt − N d]
  - "last month" → [readAt − 61 d, readAt − 28 d]
  - "N months ago" → [readAt − (N+1)·31 d, readAt − (N−1)·28 d]. Month rounding is unconfirmed, so the window is kept wide.
  - Not seen, accepted defensively: "just now", "now" and "N seconds ago" → [readAt − 1 min, readAt]; "yesterday" → [readAt − 2 d, readAt − 1 d].
  - Anything else gives a null window and counts in diagnostics.
- **Load More is never clicked automatically.** Recent claims are listed first, and those are the ones that matter for current campaigns.
- **Scan full history** is a button the user clicks (§11.5). Like the rewards loader (§4.5), it clicks Load More, waits for new entries to stop arriving, and repeats until the button disappears. It shows progress, can be cancelled, and then reads the snapshot with `complete: true`.
  - After each click, wait for the number of claims to grow and then stay the same for 3 polls (200ms each). If nothing new arrives within 8 seconds while Load More is still there, stop and report it.
- **Live sync between tabs:** `GM_addValueChangeListener` on the snapshot key. When the snapshot changes in another tab (e.g. Inventory and Campaigns open side by side), the Campaigns tab re-reads it and re-applies its rules immediately. Leaving the Campaigns page removes the listener (`GM_removeValueChangeListener`).

### 11.3 Matching the Inventory to campaigns

This happens on the Campaigns page, on every apply, as a pure function `matchInventory(campaigns, inventory)` that returns `{ claimedKeys, progressByKey, matched: { claims, groups, progress }, unmatched: { claims, ambiguous, noTime, groups } }`. Only campaigns whose rewards are known (from the page or storage, §4.5) take part. Nothing derived from the Inventory is stored per reward. It is recomputed from the snapshot, so clearing the snapshot clears every Inventory-sourced mark.

- **In Progress → campaign:**
  - Candidates are campaigns whose title equals the drop group's title (normalized), **and** that contain at least one reward whose image UUID appears in the group.
  - If exactly one candidate remains, it's the match. Otherwise fall back to "the only campaign containing all the group's UUIDs".
  - Otherwise the group is unmatched and counted in diagnostics.
  - Within the matched campaign, each Inventory reward maps to the campaign reward with the same UUID: `progressByKey[rewardKey] = { percent, requiredText, state }`. If the campaign lists that image more than once, also require the same name; if still ambiguous, skip it.
  - In the samples, all three groups match by title: PRIME TIME (THE FINALS), Season 10.5 Twitch Drops (Marvel Rivals) and Quadra Paintjobs (Cyberpunk 2077).
- **Claimed → campaign reward:** a claim maps to a campaign reward when **all** of these hold:
  - the image UUID is equal;
  - the claim's time window lies entirely inside the campaign's [start, end];
  - exactly one campaign reward on the page satisfies the first two.

  If several do, or none do, the claim is not counted. This is the conservative rule: missing a claim costs the user one manual tick, while a false match would wrongly hide a campaign.
  - **Shared images are real, even between campaigns running at the same time.** In the 2026-11-03 Campaigns sample, 42 image UUIDs appear more than once:
    - Gray Zone Warfare's "Rogue Ops - MADFINGER" and "Rogue Ops - Stage 4" overlap in time and share most of their images, so a claim for one of them is ambiguous and stays unmatched.
    - Some campaigns list the same image twice (Viking Rise "Twitch Drops"); a claim for that image also stays unmatched.
  - Coarse windows such as "last month" rarely fit inside one campaign, so old claims mostly stay unmatched. That's acceptable, because those campaigns have usually ended.
  - **Unverified:** whether Twitch allows claiming after a campaign ends. No sample shows it; the planned paired capture of a recurring daily drop (samples readme) was too hard to set up. If it happens, such a claim falls outside [start, end] and simply stays unmatched, which is the safe outcome. Don't widen the window to guess.
  - The matched claims in the samples: the 6 Enshrouded claims (campaign Nov 3 07:00 – Nov 17, claimed between about 08:45 and 13:35 on Nov 3) and the 4 Cyberpunk 2077 claims (about 20:02 on Nov 3).
- Rewards whose `imageUuid` is null (placeholder images, §2.2) never match. Neither do claims without a window (counted as `noTime`).

### 11.4 Using the matches on the Campaigns page

- **Claimed:**
  - A reward is claimed if the user ticked it (`data.claimed`), **or** it is in `claimedKeys` and not overridden. `effectiveClaims(data, match)` builds this map; Inventory entries carry `source: 'inventory'`.
  - Rule 6 (§4.1) uses this combined value, so a campaign whose rewards are all claimed through the Inventory hides itself.
- **Overrides:**
  - Unticking a reward that is claimed through the Inventory records `data.inventoryOverrides[rewardKey] = { at, campaignId }`, meaning "not claimed, whatever the Inventory says".
  - Ticking it again removes the override, and adds no manual mark: the Inventory claim is enough. Overrides survive rescans.
- **Reward tiles** (when a body is loaded):
  - The Claimed toggle shows Inventory claims as ticked, with the note "claimed (Inventory)".
  - Rewards in progress get Inventory-style progress **on their image**: a thin progress bar along the bottom of the image container, filled to the percentage, plus a small branded pill whose text depends on the state (§11.1):
    - **progress:** "{N}% of {duration}", copied from the Inventory caption.
    - **connect:** "100% · connect account". Twitch withholds the Claim button until the game account is connected.
    - **claimable:** "Ready to claim", with the bar full. TRES never claims anything itself; the user claims on the Inventory tab.

    - **complete:** "100%".

    Below 100%, the image is also dimmed slightly, like Twitch's `inventory-opacity-2`.
  - **Placement:** the bar is 4px high along the very bottom of the image container. The pill sits just above it at the bottom-left and is cut off with an ellipsis if the image is narrow. The Claimed toggle stays top-right. While a progress pill is shown, the "hidden type" note (which uses the same corner) is not.
  - Claimed rewards show no progress.
  - These are TRES elements, so they follow §4.7: the pill is branded; the bar may use Twitch's purple fill.
- **Campaign header:** a progress pill, first in the header's top-right control group (before the reason label and the Hide/⋯ buttons), shown when any of the campaign's rewards are claimed (manually or through the Inventory) or in progress. It reads "{claimed}/{total} claimed", adding " · {max}%" when an unclaimed reward is in progress. Its tooltip has one line per reward: "{name}: claimed (Inventory) | claimed | {progress pill text} | no progress". It works for collapsed campaigns too, using stored rewards.
- **Stale data:** the snapshot's age is shown in the panel (§11.5). Inventory data is never fetched in the background, so it is only as fresh as the last Inventory visit.

### 11.5 TRES UI on both pages

- **Campaigns page panel: a new collapsible "Inventory" section**, between Claimed rewards and Backup (starts collapsed like the others), containing:
  - "Inventory last read {N} hours ago · {complete history | recent claims only}", or "Not read yet. Open the Inventory tab once."
  - Counts: "{N} claims matched · {N} rewards in progress · {N} claims unmatched ({N} ambiguous) · {N} In Progress groups unmatched."
  - **Clear Inventory claims:** discards the snapshot. Every Inventory-sourced claimed mark and progress display disappears; manual ticks and overrides stay. Asks for confirmation.
  - **Rescan on Inventory tab:** navigates to `/drops/inventory` by clicking Twitch's own Inventory tab link (`a[href="/drops/inventory"]`), so the single-page app handles it; if there is none, `location.assign`. The read happens on arrival.
- **Inventory page:** TRES shows the same collapsed pill in the top-right corner, reading "TRES · {claims} claimed · {inProgress rewards} in progress" (plain "TRES" before the first read, "TRES · loading history ({clicks})" during a scan). The panel title is "TRES Inventory". It has two collapsible sections, both starting collapsed:
  - **Inventory:** last read time, whether the history is complete, the counts, and the buttons:
    - **Scan full history (Load More)**, disabled when there is no Load More, with a Cancel button and a status line while it runs.
    - **Clear and rescan:** discards the snapshot and reads the page again.
  - **Diagnostics:**
    - In Progress groups read
    - claims read
    - unrecognised time strings
    - whether Load More is present
    - last read time and how long it took
    - whether the Inventory page was found

  It has no filter sections; those only make sense on the Campaigns page. Nothing is injected into the Inventory page itself.
- Both panels, all pills, bars and buttons follow the branding rules (§4.7).

### 11.6 Storage additions (§5)

- **The snapshot has its own GM key, `tresInventory.v1`**, not a field of the settings. Only the Inventory tab writes it (plus "Clear Inventory claims" and Import on the Campaigns tab). With one shared key, a Campaigns tab open alongside would save its stale copy over a fresh Inventory read.
- `data.inventoryOverrides`: { rewardKey: { at, campaignId } }, in the settings (§5).
- A stored snapshot is sanitized on read (`sanitizeInventory`); anything invalid becomes null.
- **Export/Import:** the backup file holds the settings plus an `inventory` field with the snapshot. On import, the backup's snapshot replaces ours only if its `readAt` is newer, and overrides are unioned.
- **Reset all** clears overrides but keeps the snapshot, which is data read from Twitch rather than a setting. "Clear Inventory claims" is the way to drop the snapshot.
- **Prune** removes overrides whose campaign was pruned.

### 11.7 Tests to add (§9)

- **Extraction** from the four Inventory samples (§11.1):
  - in-progress groups, rewards, percentages, UUIDs and states. For example, at 18:44 PRIME TIME has 3 rewards at 36%, 100% (connect) and 73%; at 21:25 two of them are claimable.
  - claims with names, UUIDs and time strings: 42 in the full-history capture, 20 in each first-page capture
  - Load More present in the three first-page captures and absent from the full one
- **Relative-time windows** for every form seen, the defensive forms, and an unknown form giving a null window.
- **Window consistency:** the Enshrouded and Cyberpunk claims, read from all four captures, give overlapping windows. This guards the round-down rule.
- **`matchInventory`**, using the Campaigns sample (`page_source_opencampaigns.html`) with each Inventory sample:
  - In Progress matches by title and UUID despite a different end date (Marvel Rivals: Nov 6 vs Nov 15) and a different reward count (Quadra Paintjobs: 4 of 5).
  - All 6 Enshrouded claims match, so Enshrouded hides. The 4 Cyberpunk 2077 claims match (in the 20:34 and 21:25 captures), and the campaign stays visible because its fifth reward isn't claimed.
  - Ambiguous claims stay unmatched. Use a hand-written claim with a Gray Zone Warfare UUID shared by MADFINGER and Stage 4, timed inside both.
  - **Recurring campaigns** (no sample; hand-written): two instances of one campaign a day apart sharing UUIDs; a claim timed inside only the first instance marks only that one.
  - Windowless claims ("last month" spanning several campaigns, unknown strings) stay unmatched.
- **Overrides:** an override beats an Inventory claim. Clearing the snapshot removes Inventory claims but keeps manual ticks and overrides.
- **Live script:** on `/drops/inventory`, the Inventory pill and panel appear, the Campaigns panel doesn't, nothing is injected into the page, and the settings are never written. On the Campaigns page with a stored snapshot: Enshrouded hides, tiles show "claimed (Inventory)" and progress, headers show the progress pill. Unticking records an override; Clear Inventory claims; live sync from another "tab"; Reset all and Import. Scan full history clicks a stubbed Load More until it disappears, and can be cancelled. Rescan follows Twitch's own link.
- **Branding (§4.7):** the progress pill and header pill are branded pills; the bar is exempt.
- **Metadata:** the `@grant` list.

### 11.8 Still deferred

- "Hide subscription-only campaigns" (from the redeem line) and "hide campaigns that need an account I haven't connected" (from Connection).
- Fetching Inventory data in the background without visiting the tab.

## 12. Deliverables

1. The assumptions list (§0).
2. `TwitchRewardsEnhancementSuite.user.js`, with `@version` bumped (§1).
3. `tests/*.test.mjs` (§9), plus the output of `npm test` showing every test passing.
4. **Live validation steps.** Write a numbered checklist the owner can follow on the real page. Include the following checks:
   - Compare the diagnostics header count with the campaigns parsed.
   - Spot-check three campaigns against what's on screen.
   - Open and close a campaign, and confirm its ID, rewards and hide state don't change.
   - Confirm Closed campaigns are hidden on first install, then toggle "Hide closed".
   - On a fresh install (or after deleting the `tresIntro.v1` value in Tampermonkey's storage tab), confirm the introduction opens, Got it collapses it to the pill, and it doesn't return after a reload. Then confirm ? reopens it.
   - Check that the collapsed pill doesn't cover any campaign controls, that it expands on click, that it stays open while you click around the page, and that "–" or Esc collapses it.
   - Run Load all rewards, then reload and confirm the "rewards known" count stays and a second run has nothing to do.
   - Hide the Badge type and confirm the badge-only campaigns disappear.
   - Mark every reward in a campaign claimed and confirm the campaign hides.
   - Click a campaign's Hide button and confirm it disappears at once, with no menu.
   - Using ⋯, hide a game that has both an Open and a Closed campaign, turn Hide closed off, and confirm both stay hidden.
   - Reload and confirm everything stays hidden.
   - Export, Reset, Import, and confirm the state comes back.
   - Navigate away within Twitch and back, and confirm the panel returns.
   - Toggle "Show hidden" and check that each dimmed campaign's reason is correct.
   - **Inventory (§11):**
     - Open the Inventory tab. Confirm the pill reads "TRES · N claimed · M in progress" and matches what Twitch lists, and that Diagnostics shows no unrecognised time strings.
     - Run Scan full history; confirm Load More is clicked until it disappears and the panel says the history is complete.
     - Go back to Campaigns. Confirm a fully claimed campaign is hidden, its tiles say "claimed (Inventory)", and an in-progress campaign shows the header pill and the progress on its reward images, with the same percentages as the Inventory.
     - Untick one Inventory claim, reload, and confirm it stays unticked.
     - With Campaigns and Inventory open in two tabs, let a percentage change (or claim a reward) and confirm the Campaigns tab updates without a reload.
     - Clear Inventory claims, then Rescan on Inventory tab, and confirm the marks come back.
