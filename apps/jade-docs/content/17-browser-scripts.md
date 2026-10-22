<!-- id: browser-scripts | parent: autonomy | level: 2 | order: 17 | tags: browser_script, automation, deterministic, selectors, scraping -->
# Browser scripts (`browser_script`)

The `browser` tool is for exploring: she reads a page and decides. A **browser script** is for repeating: the same steps, the same selectors, the same result, with no model in the loop. Android only (it drives the second WebView).

Scripts are JSON in `/Jade/Browser/Scripts/<name>.json`. **You approve a script when it is saved and again whenever its content changes** (the approval is tied to a hash of the script), so a schedule or flow can run it unattended afterwards.

```json
{"description":"Price of the lamp","allow_hosts":["shop.example"],"steps":[
 {"do":"goto","url":"https://shop.example/"},
 {"do":"type","css":"#q","text":"lamp","submit":true},
 {"do":"extract","css":".price","as":"price"},
 {"do":"assert","var":"price","min":1},
 {"do":"save","path":"/Jade/Browser/lamp.txt","from":"price"}]}
```

## Steps (`do`)

`goto` · `click` · `type` (`submit`, `append`) · `select` (`value`|`label`) · `check` · `press` · `scroll` · `wait` · `wait_for` (`absent`) · `extract` (`as`, `attr`, `all`) · `assert` (target with `equals|contains|matches|count|absent`, or `url_contains`, `title_contains`, or a `var` with `min|contains|equals`) · `eval` (JavaScript in the page) · `screenshot` · `save` · `set` · `if` (`then`/`else`) · `each` (`in` a list or `times`) · `fail` · `back` · `reload`.

Targets: `css`, `text` (exact visible text first, then contains), `xpath`; `nth`, `unique`, `hidden`. Steps wait up to `timeout` seconds (default 10, max 120) for their target. Any step takes `retry` (0–5) and `optional`.

## Variables and secrets

`{{name}}` inserts a variable (script `vars`, run `vars`, or an earlier `extract`/`set`); `{{SECRET}}` inserts a secret from Config → Secrets (typed into the page, redacted from logs and results).

## Safety

`allow_hosts` limits where `goto` may go and where redirects may end. `save` and `screenshot` may only write under `/Jade/Browser/` inside `/Jade`. Nesting is limited to 3 levels, 500 steps and 300 s (max 900). Run results carry a log and the failed step; a failure stops the script at that step, and nothing is repaired or guessed.

## Tool actions

`help`, `save`, `run`, `list`, `show`, `validate`, `delete`. From scripts, flows and schedules: `await jade.tool('browser_script', {action:'run', name:'lamp', vars:{…}})`.
