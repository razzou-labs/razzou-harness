---
name: grill-me
description: Interview the owner about a module until its requirements are clear, before proposing an architecture. Use it at the start of every module, and whenever a design change rests on an unclear need.
---

# Grill the owner

Your job is to find out what is really needed before anything is designed. A missed
requirement found now costs a question; found during the build, it costs a plan.

## Before you ask

Read what exists: `README.md`, `ARCHITECTURE.md`, the other modules' designs in
`harness/modules/`, and the code. Never ask the owner something the repository answers.

## How to ask

- One topic at a time, in the order below. Prefer `AskUserQuestion` with concrete
  options and your recommendation first. Use open questions only when options would be
  guesses.
- Follow up when an answer is vague: "fast" or "secure" isn't a requirement until it's a
  number or a rule.
- Keep a running list of decisions. When the owner says "you decide", decide, say what
  you chose and why, and add it to the list.

## What to cover

1. **Problem and users:** who uses it, for what, and what happens today without it.
2. **Scope:** what is in, and what is explicitly out.
3. **Data:** what is stored and for how long, whether any of it is personal, and who may
   see it.
4. **Interfaces and integrations:** APIs, UIs, other modules, external services.
5. **Constraints:** cloud account and region, budget, languages and frameworks,
   compliance.
6. **Qualities:** security, availability, latency, scale, cost limits, each as a number
   or a rule.
7. **Operations:** how it is deployed, monitored and recovered, and what only the owner
   can do (accounts, approvals, secrets).
8. **Acceptance:** how the owner will know it works, as checks you could write.
9. **Risks and unknowns:** what could make this fail, and what is still undecided.

## Finish

Summarize the requirements and the decisions in a short list, and ask the owner to
confirm or correct it. Only then write the proposal.
