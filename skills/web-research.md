---
name: web-research
description: Answer questions about current or external facts using the web, with sources and freshness
when: The user asks about news, prices, versions, events, people, or anything you can't verify from memory
---

# Web research

Goal: return a fact-checked answer with sources, never a guess.

1. Call `current_time` once so you know "now" and can judge staleness.
2. `web_search` with a focused query (add the year if it's time-sensitive).
3. Read the result snippets. Pick the 1–2 most authoritative, on-topic URLs.
4. `web_fetch` those URLs for the actual detail — do not answer from snippets alone for anything important.
5. Cross-check: if two good sources disagree, say so. If only one weak source exists, flag low confidence.
6. Answer in 1–4 sentences. Then list sources as `- <title> (<url>)`. Note the date of the info and whether it looks current.

Rules:
- If search returns nothing useful, say so and stop — do not fabricate.
- Quote numbers/dates exactly as the source states them.
- Prefer primary sources (official docs, the company, the project) over aggregators.
