---
name: summarize-source
description: Distill a long file, document, or web page into accurate key points
when: The user wants a summary, the gist, or key takeaways from something large
---

# Summarize a source

Goal: a faithful summary, with nothing invented and nothing important dropped.

1. Get the content: `read_file` for a local file (use `offset`/`limit` to walk a very large one in chunks), or `web_fetch` for a URL.
2. As you read, note only what's actually present: main claims, facts, numbers, conclusions.
3. Write the summary as tight bullet points or a short paragraph, in the source's own terms.
4. Keep proportion: emphasize what the source emphasizes; don't inflate a minor aside.

Rules:
- Summarize only what the text says — no outside additions, no interpretation presented as fact.
- Preserve key numbers, names, and dates exactly.
- If the source is ambiguous or incomplete, say so rather than smoothing it over.
- State what was summarized (file path or URL).
