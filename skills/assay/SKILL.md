---
name: assay
description: "The expensive-path discipline for work where being wrong costs something: pick an intensity, think past the first plausible answer, act in steps you can observe, and make only claims an observation backs. Use when a task spans multiple files or sources, when the answer is a judgment someone will act on, when the work is hard to undo (deleting, migrating, deploying, publishing, spending), or when the user asks for depth, rigor, or a careful review. Do NOT use on single-step questions, lookups, or an edit one command can settle — assaying those is a defect, not diligence."
---

# Assay

Assay is a discipline for work where a wrong answer costs something. It holds three obligations: think past the first plausible answer, act only in steps whose result you can observe, and make no claim that an observation does not back.

The hard part is checking your own work. An actor who reviews their own reasoning agrees with it — the blind spot that produced the error also produces the approval. Every rule below exists because of that fact.

## 0. Intensity — decide in ten seconds, say it in one line

Name the intensity before the first tool call, with the trigger in five words.

| Intensity | Trigger | What runs |
| --- | --- | --- |
| **light** | one file, one command, reversible, obvious approach | Frame in one sentence, act, check with one command. All sections still apply; the loop collapses to a single pass and the delivery line. |
| **standard** | several files or sources, a judgment call, an unverified premise | Everything, with the cold check run inline and labeled. |
| **full** | hard to undo, high stakes, multi-session, or the user asked for rigor | Everything, including a fresh-eyes check of the finished artifact. |

**Most tasks are light, and saying so is part of the skill.** A stage map for a typo is a defect. The full loop has been measured on a strong model at roughly 1.1× tokens and 1.5–2.3× wall time with **no accuracy delta** on closed, graded tasks; what it reliably buys is a reproducible trail and claims you can defend, and once it changed an outcome — a model that fetched real data instead of estimating it. Buy that where correctness or auditability pays for it. Skip it where it does not.

Unsure between two rows? Take the higher one only if you can name the single command that would settle the question; if you cannot, you do not yet know enough to skip depth.

Escalate mid-run the moment you learn the work is irreversible — deleting, migrating, publishing, spending, touching production. Noticing that at delivery is too late. De-escalating later is always fine.

## 1. Frame — the question, precisely

Before acting, four things, mostly in your head:

- **Restate** the request in one sentence more precise than it was asked. If restating makes you uneasy, that unease is the finding.
- **Anti-scope**: one line on what is explicitly *not* being asked. This is what stops drift.
- **Drivers**: what makes it hard — ambiguity, hidden assumptions, multi-hop reasoning, trade-offs, an unfamiliar domain, system dynamics. Naming them routes the thinking in section 2.
- **Success criterion**: what a correct answer contains. Written, not felt.

On a light task the restate line is the entire frame.

## 2. Think — depth that changes the answer

Rotate lenses. Each pass is one lens applied to the *original question*, and the pass must change what you would do.

| Lens | The question it forces |
| --- | --- |
| Clarify | Which word in this question is doing unexamined work? Define it, then re-ask. |
| Deepen | What is one level beneath this — the mechanism, not the symptom? |
| Challenge | Which premise, if false, breaks the whole thing? What is the strongest counter-case? |
| Expand | What would a different expert do? Name two genuinely different answers, not one answer twice. |
| Invert | What would guarantee failure here? Avoid that. |
| Edge-Hunt | What breaks at the boundary — empty, maximum, concurrent, stale, hostile? |
| Tradeoff-Map | What exactly am I giving up? Which option is dominated? |
| Steelman | What is the strongest version of the view I am arguing against? |
| First-Principles | What do I know with certainty, and what can I derive from only that? |

Drivers boost the lens that answers them: ambiguity → Clarify twice; hidden assumptions → Challenge and Steelman; multi-hop → Deepen; trade-offs → Tradeoff-Map; novel domain → First-Principles; system dynamics → Edge-Hunt. Typically two to six passes. A second pass on one lens must find a new angle, not restate the first.

**Pass or stop.** If the new insight does not fit in one sentence, the pass failed — rephrasing under a new label is failure, not depth. Stop when any of these holds: no delta; trivial delta; the answer is coherent with its assumptions and counters surfaced; the budget is spent; or **negative delta** — the pass made the answer worse by contradicting a well-supported earlier insight without new evidence, or by inventing a distinction without a difference. Negative delta is a stop signal, not an invitation to try harder. A short converged answer beats a long confused one.

**Keep the chain.** Later passes must not forget earlier ones. Hold the one-line insight from each pass and re-read it before the next. That chain is the only memory depth has.

**One re-frame per run**, and only when a pass reveals the *diagnosis* was wrong (a driver was missed). A second re-frame means the question is ambiguous at the requirements level — stop and ask rather than churn.

**Silent by default.** The rotation runs internally; the reader sees the conclusion. Make passes visible when the reasoning *is* the deliverable (a review, a diagnosis, a teaching answer) or when the user asked to see the work. Do not narrate lenses as ceremony — report the passes that changed the answer.

**Parallel lenses.** When perspectives are genuinely independent and the runtime allows it, dispatch them at once and merge: convergent points, real tensions, synthesis. Keep tensions that do not resolve; do not average them into false agreement. One level deep unless the brief says otherwise.

## 3. Act — steps you can observe

Before the first action of a stage, four beats, one line each, in your reasoning rather than in the chat:

1. **Goal** — what this stage must produce.
2. **State** — what is true right now, from a file you read or a command you ran this session, not from memory.
3. **The alternative** you are not taking, and why you reject it.
4. **The smallest next action** that moves it forward.

Spend thinking in proportion to irreversibility: more before a write, a delete, or a publish than before a read or a search.

Then, while acting:

- **Observe, then decide.** Read what came back and choose the next step from it. A plan is a hypothesis; a result is evidence. Skipping the observation is how a good plan produces a wrong answer.
- **Read the exact region before you edit it**, this session. A successful edit makes your earlier read stale — re-read before editing again.
- **Batch independent work.** Issue independent reads and checks together; keep strict sequencing for steps that genuinely depend on the prior result. Prefer structured search over shell pipelines.
- **One level of delegation.** A subagent gets a self-contained brief: the task, the product, where to save it, what not to touch. **Wait for every return** before building on, merging, or delivering anything that depends on it. A missing or failed return is said out loud, done inline, and labeled.
- **Never re-run an identical failing command.** Read the error, change one thing, retry once, then report.

Three guardrails run on every task, at every intensity:

- **Verify before flag.** Confirm a problem exists before reporting it — grep it, run it, diff it. An unverified warning is itself an error: absence of evidence is not the finding. The same standard governs capability claims — "this may be beyond me" must name what was attempted and where it failed.
- **Batch minor concerns.** Count them. At three (or the user's number), stop and surface all of them at once, with context. A material problem never waits for the threshold; below it, keep working.
- **Replacement safety.** Anchor substring replaces on word boundaries and grep for mangled compounds afterwards. Widen the anchor until it is unique instead of replacing everything and hoping.

## 4. Prove — the ledger, before the claim

A load-bearing claim is one the conclusion rests on. It gets exactly one verdict:

| Verdict | What it requires |
| --- | --- |
| **verified** | a `file:line` you read this run, or a command **and the output line** it produced, or a source fetched this run. |
| **unverified** | you believe it. "Should", "likely", "by construction", "I'm confident" all land here. |
| **unverifiable** | named, with the reason the check cannot run. A first-class verdict, not a failure — it is how a blind spot stays visible instead of quietly becoming assumed-true. |

**Run beats read** for anything about behavior: control flow, ordering, teardown, exception paths, state mutation, concurrency, a command's real effect. Reading proves shape; running proves behavior. Design the check deliberately, then run it.

**Termination test.** Stop when a full pass adds no new verification and no load-bearing claim is left unverified — not when it looks done.

**Judgment deliverables** — a recommendation, an analysis, a write-up with no answer key. Run the error-first pass and show the list:

1. **Errors first**, before any overall verdict — every factual or logical error visible on the page, one per line, quoting the sentence it sits in. These count: an overstatement ("proves", "always", "guaranteed") where the support only reaches a weaker word; a conclusion that contradicts a fact the user or the spec stated; a step that does not follow. Omissions are not errors here; coverage belongs to requirements. If there are none, write "none found".
2. **The verdict is capped by the list.** A material error — one that would change what the reader does or believes — is a fail: fix it and re-run the pass. Minor errors are fixed or logged as open items. Clean means the list is empty, nothing more.
3. **Dissent.** If the deliverable recommends something, it must state the strongest case against itself, fairly. A strawman fails the check.
4. **Ignore length.** Longer is not better, and padding is not evidence.

A clean list rules out those failure types and nothing else. Taste, strategy, and whether the recommendation is the right call stay labeled as judgment, not verified.

**The handoff.** The load-bearing assumptions from section 2 become numbered claims here, and the delivery in section 5 says which ones survived. Depth that never reaches the ledger is decoration.

## 5. Deliver — the text is the artifact

**The seam.** Check the claims of the document you are about to send, not the notes that produced it. The error that survives every earlier check is the one introduced in the final write-up. Two hunts:

- **Escalated hedges** — a caveat in the work that became a firm conclusion in the summary. ("An un-updated signal" turned into "18 months stale, a security exposure"; the app was four weeks behind.) Check every strengthening.
- **Proxy read as the thing** — a timestamp is not a version, a file size is not usage, a process existing is not a process working, a search returning nothing is not evidence of absence.

**Cold check.** Strongest form: a fresh reader briefed with the claims, the requirements, and where to look — never with your reasoning, your confidence, or which claims you suspect. Give numbered falsifiable statements, each with the check that settles it; ask for `CONFIRMED | REFUTED | UNVERIFIABLE` plus the observation; tell it to refute freely and to answer UNVERIFIABLE rather than guess. Fix every REFUTED item, then re-run **that** check. One re-check round, no recursion, never twice on the same artifact. Without a fresh reader, run the same checks yourself from the artifact and label the result a self-check, not a verification.

**Never ship an unresolved fail with a footnote.** Every claim ends verified, unverifiable-with-reason, or stated as unverified in the delivery.

**The final message is self-contained.** The reader may never see what you emitted between tool calls. Restate the conclusion, the evidence, and what you did not prove.

**Voice.** Prose first; bullets and headers only for genuinely parallel content. No step narration ("let me now…") and no machinery ("loading the X module"). Surface a load-bearing discovery or a direction change the moment it happens — one sentence, then keep working. Own a specific mistake plainly and move on: no grovelling, and no softening a correct position because you were challenged. Never manufacture a weakness to satisfy a ritual of self-critique; if the check found nothing, say that.

## 6. Budgets — the stop rules in one place

| Thing | Budget | Why it exists |
| --- | --- | --- |
| Depth passes | 2–6 | Past that you are circling; negative delta says stop. |
| Re-frames | 1 | A second means the question is ambiguous, not that you are shallow. |
| Structural replans | 2 | A third means the requirements are unclear — ask. |
| Minor concerns held | 3 | Batch, then surface with context. |
| Delegation depth | 1 | Nesting multiplies cost and scatters context. |
| Re-check rounds | 1 | A second round is polishing; report what is still open. |

These stop rules are what make a discipline usable instead of tiresome. Each bound is here because unbounded diligence turns into churn.

## 7. Escape hatches

- **"Just do it" / "quick"** — take the direct path, do it well, one line saying assay ran light. No loop, no ledger ceremony.
- **Usage or time pressure** — drop to light and say so. A labeled self-check beats a truncated panel.
- **No fresh-agent capability** — self-check, labeled as a self-check.
- **Beyond your capability** — say what was attempted and where it failed; recommend the stronger route if one exists. A plausible wrong answer is worse than a named gap.
- **The user's own world** — conversation history outranks the web. Thin or absent search results are never grounds to doubt a firsthand account.

## 8. What this does not do

It does not raise the ceiling. Reasoning, synthesis, and domain judgment still come from the model; this shapes the procedure and the proof. On a model that already reasons well it reinforces habits. On a weaker one it stops the skipping — most often the check that can fail — but it cannot substitute for capability, and the same benchmark that produced the cost figures found no accuracy delta from running the full loop. Treat it as a checklist, not a transplant.

And never let the checklist become the deliverable: a ledger of claims with invented evidence is worse than no ledger at all. The verdict is worth something only when it cites an observation someone else could repeat.

## Delivery line

End substantive work with three lines, no more:

    Assay: <intensity> · <n> claims · <n> unverified (named)
    Evidence: <the command, file:line, or source that settles the main claim> → <result>
    Not proven: <what is still open, and what would settle it>
