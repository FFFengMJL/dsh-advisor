---
module: dsh-advisor README/GUI screenshot capture workflow (agent-browser + dsh web GUI)
date: 2026-10-19
problem_type: developer_experience
category: developer-experience
severity: medium
title: Capturing publishable dsh web GUI screenshots in the DSH sandbox — clean-session method, advisor-prediction leakage surface, and agent-browser environment requirements
description: Repeatable workflow for producing public-facing screenshots of the dsh web GUI (config cards, composer-area plugin UI, popovers) — why open-ended prompts leak injected engine/orchestration state into both the transcript and the advisor's next-prompt suggestion text, the closed-form instruction that keeps both clean, and the agent-browser + headless Chrome setup that survives the DSH file sandbox.
last_updated: 2026-10-19
tags:
  - dsh
  - screenshots
  - agent-browser
  - advisor
  - next-prompt
  - sandbox
  - documentation
applies_when:
  - Capturing GUI screenshots of the dsh web client for READMEs, docs, or issue reports
  - A plugin surface (e.g. the advisor suggestion tip) renders text derived from the session transcript and the capture must be publishable
  - agent-browser fails under the DSH file sandbox (HOME writes blocked, Chrome GPU process crash-loops)
---

# dsh web GUI screenshot capture (clean-session method)

## Context

Publishable screenshots of the dsh web GUI must not leak internal state. Two leak surfaces appear together when the captured session is driven by an open-ended prompt:

1. **The transcript itself.** The primary agent's answer to an open-ended question tends to engage whatever harness/engineering context is injected into its session (engine-status rows, lifecycle/store discussion), which must not appear in a public README image.
2. **The advisor's next-prompt suggestion.** The advisor predicts the user's likely next prompt from the session transcript; if the transcript carries injected engine-status content, the suggestion text references it (observed: "Select one of the two active lifecycles…"). The suggestion tip renders under the composer and lands in the frame even when the transcript above is scrolled away.

The GUI offers **no session-delete function** (header menu, hover, context menu all lack it in the preview build), so a polluted scratch session cannot be removed after the fact — cleanliness must be achieved up front.

## Guidance

1. **Create a fresh scratch session** (新会话) — never reuse a session that already carries engineering discussion.
2. **Drive it with one closed-form instruction** that forces a minimal, deterministic reply, e.g. `Reply with exactly: OK`. The transcript then contains exactly the instruction and the one-word reply, and the advisor's prediction for that session is correspondingly benign (observed: the suggestion becomes `OK`).
3. **Wait for the turn-completion marker**, then wait a few seconds more for the advisor prediction (the client idle-polls the suggestion endpoint); capture while the composer is empty — the tip renders only on an empty composer in the plain phase.
4. **Verify the frame before committing**: re-open the image and confirm the expected subject elements AND that no lifecycle/workflow/store/engine-status keywords appear anywhere in the visible transcript (a DOM-level keyword scan is even stronger).
5. **Encode with `cwebp -q 80`** at a 1440×900-class viewport; keep the exact filenames the docs reference.

Environment (DSH file sandbox):

- `agent-browser` cannot write `~/.agent-browser` under the sandbox → run with `HOME=/tmp/<dir> agent-browser --cdp <port>`.
- Start Chrome manually with `--headless=new --no-sandbox --disable-gpu` — otherwise the GPU process crash-loops and the browser never becomes ready.
- Authenticated GUI URL carries a token; pass it only via the browser, never into captured frames, commits, or reports.

## Why This Matters

The advisor observing the transcript is the product working as designed — which is exactly why any harness-injected content in a capture session propagates into user-visible suggestion text. Closed-form instructions sever that propagation at the source, making the capture reproducible on the first attempt instead of after a polluted-frame rework round.

## When to Apply

Any documentation, README, or issue-report screenshot of the dsh web GUI; any capture of plugin UI whose content derives from session state (advisor tip, injected notes, status popovers).

## Examples

Applied in dsh-advisor's README screenshot refresh (plan dsh-advisor-readme-latest-capabilities-n14): first pass used an open-ended prompt ("list the files in this repo") and produced frames whose transcript and suggestion text both referenced engine lifecycle state; the recapture with a fresh session + `Reply with exactly: OK` produced clean frames for the config card (8 fields incl. the next-prompt switch), the `✦ 建议: … → 采纳` dock tip, and the session-header 顾问 popover (whose pin/default buttons render an accurate disabled state with no session override).
