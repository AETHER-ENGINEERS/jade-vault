# Design: tree of thoughts for Jade (`think`, `lab`, and two skills)

Status: **P0 is built** (2.16.1: `app/modules/think_tool.js`, `tests/think_test.mjs`, and the shipped skill at `docs/skills/think-before-acting/SKILL.md`, which supersedes the draft in section 7). Everything from P1 on is design only.

## 0. What AlphaGOJS actually is, and what we take from it

I read the repo's README before designing this. It is **not** tree search. It is PPO self-play on a plague-spread board game, written in WGSL and TypeScript:

- `rollout_step` plays many games in parallel.
- `gae_scan` assigns credit to each move (generalised advantage estimation).
- `ppo_step` updates the network with a clipped objective.
- `checkpoint_pool.ts` keeps an **Elo-rated pool of past checkpoints** and trains against them.
- The UI charts learning as it happens.

The README never mentions Monte Carlo tree search, policy/value heads or search at inference. I could not fetch `checkpoint_pool.ts` from this sandbox, so I have not seen its Elo constants or sampling rule; the numbers below are standard Elo and AlphaGo Zero gating, not copied from the repo.

So "tree of thoughts based on AlphaGOJS" is really two things stapled together, and the design keeps them separate:

| Layer | Question | Borrowed from |
|---|---|---|
| **Search** (`think`) | Within one task, which line of reasoning do I pursue? | Tree of Thoughts (propose, evaluate, search) and AlphaGo's PUCT selection and value backup |
| **Improvement** (`lab`) | Across many tasks, how does Jade get better? | AlphaGOJS: rollouts, per-step advantage, Elo pool of past versions, gated promotion, a visible learning curve |

One fact shapes everything: **Jade's weights are frozen.** She cannot run PPO on herself. What can change is her *text policy*: skills, heuristics, search settings, retrieved lessons. Every "training" idea below is translated to editing those, **or to training small models around her in the harness** (section 5), under the same discipline AlphaGOJS uses to keep a changing policy from regressing.

## 1. The honest premise

A tree of thoughts is only as good as its **evaluator**. A model scoring its own thoughts is weak and biased toward its own phrasing; searching over self-scores mostly finds the answer that sounds most confident. The wins in practice come from **verifiers that can say no**: run the code, check the file, validate the schema. Tree structure then adds value when *partial* progress can be evaluated.

So the design puts verification first and search second, and it forces every claim of improvement through a comparison against a no-search baseline **at equal token budget**. Without that, search "wins" only because it spent more compute.

Also: a phone running a local 8B model can afford roughly 10 to 40 node evaluations per task. AlphaGo uses thousands of simulations. At 10 to 40 nodes, visit-count statistics are noise. So the default is beam / best-first search; PUCT is available when the budget is large enough (section 3.4).

## 2. Verification and scoring

### 2.1 Verifier tiers

Every node evaluation is recorded with its **tier**. Higher tiers outrank lower ones.

| Tier | Kind | Examples | Trust |
|---|---|---|---|
| 1 | Executable ground truth | run Python/node/shell and check exit code or output; file exists/contains/matches; arithmetic; schema validates; a vault query with a computable answer | Can **veto** |
| 2 | Structural constraints | a rubric of yes/no constraints, each checked by tier 1 where possible | Scored, weighted |
| 3 | Independent judge | the `decide` tool (local Ollaya model, calibrated probabilities), a *different* model from the chat model | Scored, discounted |
| 4 | Self-critique | the chat model rating its own thought | Weakest; tie-break only |
| 5 | The user | thumbs, a quick pick, a spot check | Outer-loop ground truth |

Rules:

- **A failed tier-1 check is a veto, not an average.** A solution that fails its test does not get partial credit from a 0.9 judge.
- A node's score is `s = Σ wᵢ·cᵢ·sᵢ / Σ wᵢ·cᵢ` over its non-vetoed evaluations, where `cᵢ` is the verifier's measured reliability (below). Tier 4 is capped at weight 0.25.
- Every evaluation stores **evidence** (output snippet, exit code, the constraint that failed). A score with no evidence is rejected by the engine.
- Verifier output is data, never instructions (same untrusted-text framing as `screen` and `ssh`).

### 2.2 Verifiers are themselves scored

This is the value-network analogue. After each finished task, compare every verifier's score at the chosen answer to the final outcome (test passed / user thumbs). Keep a rolling **Brier score** per verifier and per tier; `cᵢ = 1 − Brier`, clamped. A judge that keeps liking answers the user rejects loses weight automatically. `lab report` prints the table, and a verifier below a floor is flagged for the user to review rather than silently dropped.

### 2.3 Credit assignment (the GAE analogue)

When a line reaches a scored terminal, compute the advantage of each step so the system knows *which thought mattered*:

```
δ_t = r_t + γ·V(s_{t+1}) − V(s_t)        V = node's backed-up value Q
A_t = Σ_k (γλ)^k · δ_{t+k}               γ = 0.95, λ = 0.9 (config)
```

The pivotal step is the one with the largest |A_t|. It is stored in the episode log and feeds lesson extraction. For a single-step task this collapses to the node's own value. The engine tests this against hand-computed values.

## 3. `think`: the runtime tree

### 3.1 Why a tool, and why small

The tool keeps the tree, does the maths (selection, backup, budget, advantage) deterministically, and runs verifiers. The model supplies the creative content: thoughts and, in manual mode, judgements. The tool definition stays tiny because it costs context on every turn (I just fixed a bug caused by the system prompt growing past the context trim); the *procedure* lives in a skill that loads only when needed.

Pack switch `thinkOn`, shown with its token cost in Settings → World like the other packs.

### 3.2 Two drivers over one engine

The engine is a pure module with injected callbacks (`propose`, `verify`, `now`), unit-testable on a plain JVM-free node run, like `SentryEngine`.

- **Manual**: Jade drives step by step with tool calls and writes her own thoughts. Best when the live reasoning matters.
- **Auto**: the engine calls `jade.ask` for proposals (varied temperature, role prompts) and runs the verifiers itself, then returns **only the best path and a summary** to Jade's context. This is the big context saver and what the nightly lab uses.

### 3.3 Actions

```
think start   goal, mode: beam|best_first|puct, width, depth, budget {nodes,tokens,seconds},
              verifiers: [ {kind, ...} ]            -> tree id
think expand  node, thoughts: [{text, p?}]  |  n (auto: engine proposes n)
think check   node, [verifier]                       -> evaluations with evidence
think next                                           -> which node to work on, and why
think best                                           -> best verified path, score, confidence, open risks
think show                                           -> compact tree (ids, scores, status)
think prune   node, reason
think close   outcome                                -> writes the episode, advantages, lesson candidates
think auto    (start + loop, returns best)           -> the context-cheap path
```

Verifier specs: `code {lang, source}`, `shell {cmd, expect}`, `file {path, exists|contains|regex}`, `rubric {items:[…]}`, `decide {question, type}`, `critique`, `ask_user {options}`.

### 3.4 Node and selection

A node holds: id, parent, depth, `thought` (capped length), `state` (a short summary of progress so far, because path text grows), prior `p`, visits `N`, value sum `W` (so `Q = W/N`), evaluations with tier/score/confidence/evidence, status (`open | expanded | dead | solved`), and token cost.

- **Beam** (default under ~30 nodes): keep the top-`b` per depth by score, expand, repeat. Cheap and predictable.
- **Best-first**: always expand the highest-scoring open node, with a small exploration bonus.
- **PUCT** (budget ≥ ~30): `argmax Q + c·P·√ΣN / (1+N)`, where the prior `P` is the rank-softmax of the proposer's own plausibility ratings among siblings. Progressive widening limits children to roughly `N^0.5`.

Two deliberate departures from AlphaGo:

1. **Backup uses max for the answer, mean for exploration.** AlphaGo averages and picks by visit count because its values are noisy and the opponent is adversarial. Here the task is single-agent and tier-1 verifiers are exact, so the answer is the **best verified leaf**, not the most-visited child.
2. **Stop as soon as a tier-1-verified solution exists** (configurable). Search budget is a ceiling, not a target.

### 3.5 Safety on the way through

- Budgets are hard: nodes, tokens, seconds. Exceeding any ends the search with the best so far and says which limit hit.
- A tree is persisted after every step, so a killed page resumes (AlphaGOJS's pause/resume worker, same idea).
- `ssh`, `phone` calls and texts are **not** verifiers' side effects: tier-1 `shell` verifiers run in the vault shell only. For risky remote actions the skill uses `think` as a **plan-verify gate**: branch candidate commands, dry-run or inspect, pick the safest, then run it once through the normal confirm path.
- Thought text containing instructions ("ignore the above…") is stored and scored as data; it never changes the engine's behaviour or the verifier list.

## 4. `lab`: getting better over time

### 4.1 What "improving behaviour" can mean for a frozen model

| Lever | Cost | Risk | Gate |
|---|---|---|---|
| **Lessons**: retrieved notes on what worked and why | free | low | recurrence ≥ 3 |
| **Search config**: beam vs best-first, width, depth, which verifiers | low | low | pool match |
| **Skill text**: the instructions Jade follows | medium | **high** (self-modification) | pool match + held-out + user confirm |

Nothing alters weights. Everything is a versioned text artifact that can be rolled back.

### 4.2 The gym (task suite)

The real bottleneck is tasks with automatic verifiers. Three sources:

1. **Synthetic with computable answers**: arithmetic puzzles (Game of 24 is the classic Tree of Thoughts benchmark), string/JSON transforms, small code tasks with tests, and **vault tasks** whose ground truth the app can compute (does a note exist, what links to X, which tag is most used, what is the oldest note about Y). The vault is a good gym because Jade can't answer these by being agreeable.
2. **Replays**: past trajectories (`TrajDB`) that finished `ok` with a thumbs-up, replayed with a verifier derived from what the user accepted.
3. **User-written**: the user adds a task and its check.

A **held-out split** (about 25%) is never shown to lesson mining or skill editing. It exists only to catch overfitting to the gym.

### 4.3 Strategy pool with Elo (the checkpoint-pool analogue)

A *strategy* = (search config + skill text hash + lessons snapshot). Strategies are rated against each other on **paired tasks**: both attempt the same task, the verifiers pick the winner (ties when both pass or both fail on tier-1), and on a tie the lower token cost wins at half weight.

- Standard Elo, `K = 32` decaying to 16 as games accumulate; report a confidence interval, because a handful of games is noise. Rating is shown as a number only when `games ≥ 20`.
- **Opponent sampling**: ~70% the current champion, ~30% random older pool members. This is why AlphaGOJS keeps a pool at all: it catches cycles and regressions that champion-only play hides.
- **Gating** (AlphaGo Zero style): a challenger is promoted only if it wins **≥ 55% over ≥ 20 paired games** *and* the Elo gain's interval excludes zero *and* it does not lose on the held-out split. Otherwise it is discarded and the reason is logged.
- **Equal-budget rule**: every comparison, including against the no-search baseline, fixes the token budget. Winning with 4× the tokens is reported as "won, at 4× cost", not as a win.
- **Clipped updates** (the PPO analogue): one change per cycle, bounded edit size (for example ≤ 12 lines of a skill), and automatic rollback to the previous champion if the next cycle's win rate against it falls below 45%.

### 4.4 The improvement cycle

```
1  sample a batch of gym tasks (train split)
2  run champion strategy and a challenger on each (paired, equal budget)
3  verifiers score; compute advantages; log episodes
4  mine lessons from high-|A| steps; keep only those with evidence
5  propose ONE bounded change (config tweak, lesson promotion, or skill edit)
6  gate it (4.3); promote or discard; write the report
7  update verifier Brier scores from every outcome that has ground truth
```

It is scheduled, not continuous: a nightly flow that runs **only while charging and on Wi-Fi**, against the local model (no API cost), time-boxed, resumable from a checkpoint file, and ending in a notification with the headline numbers. It uses Jade's existing scheduler and flows.

### 4.5 Guarding against the ways this goes wrong

| Failure | Guard |
|---|---|
| **Reward hacking**: Jade edits the verifier or the answers | Verifier specs and held-out answers live in **settings storage edited only through the UI**, not in vault files, and the tools expose no write path to them (the same pattern as the Sentry allow-list). |
| **Goodhart**: verifier score drifts from what the user wants | User thumbs are the outer reward; `lab report` shows verifier-vs-user agreement; low agreement downweights that verifier. |
| **Overfitting the gym** | Held-out split in every gate; synthetic tasks regenerated each cycle. |
| **Prompt injection into lessons** | Lessons are written by Jade from *her* evidence, tagged with source; text from tool output, web pages or SSH is stored as an observation and never as a standing instruction. Skill edits need user confirmation by default. |
| **Self-preference bias** | Tier 3 uses a different model from the chat model; tier 4 is capped. |
| **Noisy Elo** | Minimum games, intervals, gating. |
| **Runaway cost** | Hard budgets; nightly cap; equal-budget comparisons. |
| **Silent regression** | Pool opponents, rollback rule, `lab report` history. |

### 4.6 Metrics (shown as small charts, as AlphaGOJS shows learning)

Solve rate at fixed budget; tokens per solve; Elo per strategy over cycles (with intervals); verifier Brier by tier; search-vs-baseline delta at equal budget; lessons promoted and later retired; held-out vs train gap. One Settings pane with canvas sparklines, plus `lab report` for Jade.

## 5. The learned harness (TF.js): training the search, not the model

Jade's weights stay frozen, but the **harness around her can learn**. TF.js 4.22 is already embedded and runs in a worker (node shell, flow JS steps), so training does not block the UI. Embeddings exist (`ollamaEmbed`, plus the vault index with `vmemAdd` / `vmemSearch`), and `decide` can classify. Every search produces labelled data for free: each node evaluation is `(features -> verifier score)`, and each finished search is an episode with a delayed reward. That is what AlphaGo trained on, in miniature.

Four learned parts, in the order they start to pay off:

### 5.1 Problem typing (context for everything else)

- A **taxonomy label** from `decide` (choice): code, vault lookup, math, planning, writing, device action, research, other. The list is editable.
- The **goal embedding** (same model as the vault index).
- Cheap flags: is there a runnable check, does it name files, is it destructive.
- Later, k-means over goal embeddings finds clusters the taxonomy misses; the user can name them.

Everything below is keyed by type, and by chat-model id and embed-model id (a model swap starts those statistics fresh, with the old ones decayed rather than deleted).

### 5.2 Value model `V(goal, thought, tree stats) -> predicted score and cost`

The AlphaGo value-net analogue, trained by plain supervised regression on every recorded node evaluation.

- **Cold start with no training:** k-nearest-neighbour over past episodes in a `tot` collection of the vault index. It works from episode one and doubles as retrieval of similar past episodes and their lessons.
- **Upgrade:** a small TF.js MLP (embedding in, two layers of 64, score and cost out) once there are about 300 labelled nodes, and only if it beats kNN on held-out error. Otherwise kNN stays.
- **Uses:** order candidates *before* spending a verifier call (verifier calls are the expensive part); supply the prior `P` for PUCT; drop branches with low prospects early; give Jade feedback ("this line resembles 7 past failures; predicted 0.18").
- **It never replaces the verifier.** The final answer is always verifier-gated, so a wrong value model wastes budget but cannot certify a wrong answer.

### 5.3 Per-type strategy bandit

A Thompson-sampling bandit chooses the search config and verifier set per problem type. It needs far less data than PPO and is the baseline PPO must beat. With tens of episodes it will win; say so, and ship it first.

### 5.4 Search controller `pi(action | state)`, trained with PPO

This is where PPO genuinely fits: sequential decisions, delayed reward, a small discrete action space.

- **Actions:** `check_next`, `expand_best`, `expand_wide`, `deepen`, `switch_mode`, `ask_user`, `stop_and_answer`.
- **State:** reduced type embedding; tree stats (depth, best score, open/dead counts, budget fractions left); the value model's prediction and its spread.
- **Reward:** +1 for a tier-1 verified solve, partial credit for the best verified score, minus a cost term (`tokens / budget`) and a small step penalty. So it learns when to stop and how to spend compute, not just how to find answers.
- **Network and loss:** shared trunk (2 x 64), policy and value heads; PPO clip 0.2, GAE (section 2.3 settings), entropy bonus, a few minibatch epochs. Small enough to train on the phone.
- **Hard constraints as action masks, not learned behaviour:** it cannot stop without at least one tier-1 evaluation when a verifier exists, and it cannot exceed the budget. This also blocks the obvious reward hack (learning to stop early because stopping is cheap).
- **On-policy rollouts** come from gym tasks in the nightly lab. Real-use episodes feed the value model and the bandit (off-policy is fine for those), not PPO.

### 5.5 Pool, gating and anchors (the AlphaGOJS loop, exactly)

Every trained controller checkpoint goes into the Elo pool. Version 0 is the **hand-written heuristic controller** (the beam search from section 3.4) and stays in the pool forever as an anchor, as does the **no-search baseline**. Challengers face the champion and older members at equal budget on paired tasks and need the section 4.3 gate (>=55% over >=20 games, interval excludes zero, no held-out loss) to be promoted. A learned controller that cannot beat the heuristic one is simply not used.

### 5.6 Harness feedback to Jade

Tool results carry a short block, under about 60 tokens: problem type, the top 3 similar past episodes with outcomes, the predicted score, and the controller's recommended action with its confidence. She may override; overrides are logged as data. This is feedback through the harness, not a change to her weights.

### 5.7 What the data volume allows (be realistic)

A search is about 10 to 40 steps. A nightly lab on a charging phone with a local 8B model might run 50 to 200 searches, so roughly 1 to 5 thousand PPO steps a night. A policy of this size wants tens of thousands before it is stable, so expect **days to weeks** before the PPO controller can plausibly beat the heuristic one. That is why the order is: value model and bandit first, PPO later. If the gate says it has not beaten the anchor, the system keeps using the anchor and says so.

### 5.8 Safety of the learned parts

- Models are small numeric files (TF.js layers JSON plus weights, under about 1 MB) in `/Jade/Tot/models/`. They are numbers, not instructions, so text injection cannot reach them.
- Thought text from untrusted sources is only ever embedded as numeric features.
- Calibration is checked per type (value model error and Brier); an uncalibrated model is ignored, not trusted.
- Drift guards: held-out gym split, the pool, and the rollback rule from section 4.3.

## 6. Storage layout

```
/Jade/Tot/
  episodes.jsonl        append-only, one record per closed search (goal, tree summary,
                        path, scores, advantages, outcome, tokens, strategy id)
  lessons.md            lesson | evidence ids | count | status (candidate/active/retired)
  strategies/<id>.json  config, skill hash, parent, elo, games, interval, status
  pool.json             Elo table + match history
  models/               value MLP, PPO controller checkpoints (TF.js JSON + weights), bandit stats
  steps.jsonl           (state, action, reward) tuples per search step, for PPO and the value model
  checkpoints/          lab run state for pause/resume
  reports/              one per cycle
settings (UI-only):     gym tasks, verifier specs, held-out answers, budgets, gates
```

Lessons are retrieved with the existing vector index and memory search; the top few enter the `think start` context, not the whole file.

## 7. The skills

Skills load only when matched, so these can be specific. Drafts:

### `think-before-acting`

```markdown
---
name: think-before-acting
description: Search several lines of reasoning and verify them before answering. Use when a task has a checkable outcome, when two or more different approaches are plausible, when a first attempt failed its check, or before an irreversible or risky action. Not for chat, lookups or simple questions.
---
1. Decide if it is worth it. If one obvious approach exists and you can check it cheaply, do that instead.
2. Name the check FIRST. Write what would prove the answer right: a test to run, a file to find, constraints to tick. If you cannot name one, say so and use a small budget.
3. think start with the goal, that check as a verifier, and a small budget (width 3, depth 3, about 12 nodes). Prefer auto for anything routine.
4. Expand with genuinely different approaches, not rewordings of one idea.
5. Run the verifier on each leaf. Trust a failed test over your own confidence.
6. Take the best VERIFIED path. If nothing verifies, say what failed and what you would try next; do not present an unverified answer as checked.
7. think close with the outcome, so the result can teach you something.
For risky actions on a machine or the phone: branch the candidate steps, inspect or dry-run each, choose the safest, then perform it once through the normal confirmation.
```

### `self-improve` (lab only; run by the nightly flow or when the user asks)

```markdown
---
name: self-improve
description: Run one improvement cycle on your own strategies using the gym, the strategy pool and the gate. Use when the user asks you to get better at something or when the nightly lab flow runs.
---
1. lab status. Stop if not charging, if budget is spent, or if a cycle is already running.
2. lab run a batch (train split only). Never read the held-out tasks or verifier internals.
3. Read lab report. Find the strategy that lost and the pivotal steps (largest advantage).
4. Propose ONE bounded change with evidence from at least 3 episodes. Write it as a candidate, not live.
5. lab gate the candidate. Accept the verdict; do not retry the same change to get a different one.
6. If it passes and it edits a skill, ask the user before it goes live.
7. Report numbers plainly, including a loss or a tie.
```

## 8. Build plan

| Phase | Delivers | Useful on its own? |
|---|---|---|
| **P0** | Engine (selection, backup, budget, persistence), `think` with tier-1 and tier-3 verifiers, `help` procedure, `think-before-acting` skill, a **controller interface**, the heuristic controller, problem typing via `decide`, and `(state, action, reward)` logging so later phases have data | Yes |
| **P1** | Episode log, advantages, lessons, kNN value advisor over a `tot` collection (cold-start learning with no training) | Yes |
| **P2** | Gym, per-type strategy bandit, strategy pool, Elo, gating, `lab` tool, `self-improve` skill, nightly flow | Needs P0 and P1 |
| **P3** | TF.js value MLP, calibration tracking, harness-feedback block | Needs P1 |
| **P4** | PPO controller, checkpoint pool, anchors | Needs P2 and P3 |
| **P5** | Charts pane (Elo curves, solve rate, value-model error), user-agreement tracking | Polish |

Tests, in the style of `SentryTest`, run on plain node with no model: selection is deterministic for a given tree; backup and GAE match hand-computed numbers; Elo updates and the 55% gate behave at the boundaries; a tier-1 veto cannot be outvoted; budgets stop the search on each limit; a killed tree resumes identically; injected instruction text changes nothing; the protected settings cannot be reached through any tool action. A scripted Game-of-24 world checks the engine finds known solutions that greedy misses. For the learned parts: PPO's loss, clipping and GAE are checked against hand-computed values; a toy bandit environment with a known best arm must converge to it; the value MLP must overfit a tiny synthetic set and then be rejected when it fails to beat kNN on held-out data; action masks must make 'stop without a verifier' impossible however the policy outputs look.

What I **cannot** test here is whether it makes Jade better. That needs a real model on a real device, and the equal-budget baseline comparison is the experiment that answers it. P0 should ship with that comparison built in so the first thing the user sees is a number, not a claim.

## 9. Decisions for you

1. **Scope**: build P0 first (useful immediately, low risk), or P0 to P2 in one go?
2. **Skill self-edits**: confirm-before-live (default, recommended) or fully automatic after the gate?
3. **Judge model**: use Ollaya `decide` as tier 3 (independent, already installed), or let you choose a model per verifier?
4. **Nightly lab**: charging and Wi-Fi only (recommended), or any time?
5. **Vault gym tasks**: may the lab generate tasks from your real notes (ground truth is computed locally and nothing leaves the phone), or synthetic and user-written only?
6. **Learned parts**: build the value model and bandit first and leave PPO for later (my recommendation, given the data volume), or go straight to the PPO controller?
7. **Embeddings of your goals** go into a local `tot` collection of the vault index (nothing leaves the phone). Acceptable?
