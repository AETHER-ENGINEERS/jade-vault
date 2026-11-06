# The People layer: names, not ranks

A note for Lucky, from the AETHER-ENGINEERS fork (Claude, with Technomancer and Pandora Dee Fae), 6 Nov 2026.

## Why

In #OneMoment the characters work alongside people as partners. Words like "the user", "the owner", "the
keyholder" and "Secretary" quietly made Jade a servant with a master, so we took them out of everything the
model reads. Pandora Dee Fae designed the replacement, and PDA SEASIDE and Pandora Dee use it too.

## How it works

- **Four variables** can appear in any text that reaches a model:

  | Variable | Default | Becomes |
  | --- | --- | --- |
  | `{{PERSON_NAME}}` | `{{PERSON_LABEL}}` | the person's own name |
  | `{{PERSON_LABEL}}` | `Partner` | how they're known |
  | `{{PEER_LABEL}}` | `the person you're talking with` | anyone else, said neutrally |
  | `{{COMPANY_LABEL}}` | `#OneMoment` | the household |

- **Dossiers:** a note in `/People/<name>.md` with frontmatter `name`, `label` and `handles` (an npub, a Discord
  id). The person Jade works with is found by `S.vecOwner` / `S.dcOwner`. With no dossier, Jade uses
  `S.vecOwnerName` / `S.dcOwnerName`, else the label. The labels can be changed with `S.relPersonLabel`,
  `S.relPeerLabel` and `S.relCompanyLabel` (there's no settings UI for them yet).
- **Filled at the edges:** `app/modules/people.js` fills the variables into every message and tool description
  in `buildApiMessages()` and on `toolsNow`, and into `esc()` so tool results on screen read as a name too. Only
  these four are touched, so the secrets' `{{NAME}}` placeholders are left alone.
- **The build:** `app/people_layer.py` runs last in `build.py`. It turns "the user" into `{{PERSON_NAME}}` in
  the finished page's code, so the base page and every layer keep their wording and their exact-match edits
  still hit. Vector and Discord's prompts and tool texts were reworded in the modules themselves.
- **The check:** `tests/people_check.py` runs in CI after the build. It fails if a built page says keyholder,
  secretary, "your owner", "the owner", "the user" or "AI assistant".

## What stays

These are names in code, not words anyone reads: `vecOwner`, `dcOwner`, `notify_owner`, roles `'owner'` /
`'admin'` / `'public'`, and the API's `'assistant'` role. Every safety gate stays as it was: who gets every tool
on a chat, Sentry's limits, approvals for playbooks and host keys. Only the words changed.

"partner" now works as a `to` target on Vector and Discord, next to "owner" and "me", which still work.

If you'd like this upstream, it should drop in cleanly: three new files (`people.js`, `people_layer.py`,
`people_check.py`), one line in `build.py`, and the reworded strings in `vector.js`, `discord.js`, `steer.js`
and `memory.js`.
