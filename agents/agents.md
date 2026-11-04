# Instructions for coding agents

These instructions apply to any AI coding agent working in this repository.

This repo holds one Tampermonkey userscript, `TwitchRewardsEnhancementSuite.user.js` (Twitch Rewards Enhancement Suite, "TRES"). It covers Twitch's Drops pages: it hides and sorts campaigns on https://www.twitch.tv/drops/campaigns, and reads the Inventory tab (/drops/inventory) to learn claimed rewards and progress. All features live in this one script so they share storage. See `README.md` for the development approach.

## The spec is the source of truth

`prompt.md` is the specification the script is generated from. The script must be reproducible from it.

- **Every behaviour, UI or test change must update `prompt.md` in the same piece of work.** This applies even to small tweaks such as a button's position, a count beside a label, a section's default state, or a test-only option. If a change exists only in the code, it is lost the next time the script is regenerated.
- When a change fixes something that went wrong, record in the spec what went wrong, so a regenerated script doesn't repeat it (see the Hide button note in §4.2 for an example).
- If the code and `prompt.md` disagree, say so and ask the owner which is right; don't silently follow either.
- When the owner asks for a change, finish by stating which `prompt.md` sections were updated.

## Tests

- Run `npm test` after every change to the script, and report the result. Don't call work done while a test fails, and don't weaken a test to make it pass.
- Add or update tests for each behaviour changed and each bug fixed (`prompt.md` §9 lists what the tests cover).
- Tests must never depend on the real date: tests that run the whole script pass the sample's capture time as `options.now`.

## Samples

- `samples/` holds captured snapshots of Twitch's rendered pages; `samples/samples_readme.md` explains how to capture each one. Check claims about Twitch's markup against these files; don't guess.
- Capture with `samples/capture-snippet.js` in the browser console. "Save Page As" and View Source don't contain the campaigns.

## Releases

- The file name is always `TwitchRewardsEnhancementSuite.user.js`. Tampermonkey updates installed copies from its raw URL on `main`, so the name must never change.
- Pushing to `main` releases the script to every user. Only push with all tests passing. Commit or push only when the owner asks.
- **Bump `@version` automatically, once per release.** The owner publishes by committing and pushing, so the version must already be bumped by then:
  - Before changing the script, compare its `@version` with the published one (`git show origin/main:TwitchRewardsEnhancementSuite.user.js`).
  - If they're equal, this is the first change since the last release, so bump the version.
  - If the working copy is already higher, it has been bumped since the last release; don't bump again.
  - Bump the **minor** version (0.6.0 → 0.7.0) for new features or behaviour changes, and the **patch** version (0.6.0 → 0.6.1) for fixes only. If a later change in the same release is a feature but the bump so far was a patch, raise it to a minor bump.
  - Say in your reply which version the change will ship as.

## Code conventions

- One file, in the six sections listed in `prompt.md` §8. Tabs for indentation.
- Use only stable selectors (`drops-root__content`, `accordion-header`, `drop-details__label`, `drop-benefit__image-container`, `tw-pill`, ARIA attributes, text). Never use Twitch's obfuscated class names such as `Layout-sc-…`.
- Mark every injected element with `data-tres`, and build page-derived text with `textContent`, never `innerHTML`.
