# Explainer configuration

Copy this file to `docs/agents/explainer.md` in your repository and edit it. The `explainer` skill
reads it before writing a brief, and passes it to the builder. Every key is optional; delete the
ones you do not need. With no file at all, the skill uses the defaults in its `SKILL.md`.

- **Output dir:** `docs/explainers/`
- **Reference page:** `docs/explainers/release-pipeline.html` — an existing page the builder reads
  for house shape. Leave unset until you have one.
- **Gate command:** `node scripts/check-explainer.mjs <path>` — run over each new or changed page.
- **Font source:** `node scripts/check-explainer.mjs --print-font-block` — or a path to a page whose
  `@font-face` block is canonical. Unset means system font stacks.
- **Drift-proofing:** `manifest` — one of `off`, `manifest`, `manifest+anchors`.
- **Builder agent:** unset — name a sub-agent here only if you already maintain one that carries the
  skill's `BUILD.md` conventions.
- **Register step:** add the page to `.prettierignore` and to the page list in
  `scripts/check-explainer.mjs`.

## House notes

Anything else the builder should know about this repository's pages — a motion vocabulary, a
colour role that carries meaning, a component every page reuses. Keep it short; the skill's
`BUILD.md` already carries the general conventions.
