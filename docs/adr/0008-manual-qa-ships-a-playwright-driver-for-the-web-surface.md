---
status: accepted
---

# manual-qa ships a Playwright driver for the web surface

`manual-qa` ships `web.mjs`, a driver for the `web` **Surface** on Playwright's Chromium, as it ships `http.mjs` for `api`. At run time, the runner turns one scenario's steps into a JSON step sequence under `working_dir`, and the driver carries it out, one browser context per **Session**. At each step it saves a still, the element the step is about, that element's visible text, the Session and the time, plus a video per Session when asked. It makes no assertions. Playwright, Chromium and `ffmpeg` are optional: the driver loads Playwright from the repository under test and never installs it, and run readiness says in a note whether each is there and what the run loses without it.

Before, a `web` scenario was driven by whatever browser the harness offered, so its evidence depended on the harness. One saved `s<n>.png` files, another only showed screenshots, another recorded GIFs; none recorded which element a step was about or when it happened, which later evidence built from a run's records needs. Some harnesses drive their browser poorly, and runs on Cursor have struggled.

Recorded in [#232](https://github.com/mnaimfaizy/agent-kit/issues/232), part of [#231](https://github.com/mnaimfaizy/agent-kit/issues/231).

## Considered Options

- **Keep the harness browsers only.** Rejected. Evidence would stay as uneven as the harnesses, and a scenario's records could never say what the runner was looking at, or when.
- **Commit the step sequences, or write them at compose time.** Rejected. A committed sequence is a second end-to-end suite that nobody maintains, and the plan would stop being prose a person can run by hand. The runner writes each sequence at run time, from the plan's steps, as it would click through a screen, and it is never committed.
- **A driver that checks the expected result itself.** Rejected. A driver with assertions is a test framework, and the Residue is what the test suites did not cover. The runner judges the saved stills and text against **Expected result:**, as on every other surface, which keeps manual-qa `DESIGN.md`'s line between a QA driver and a test framework.
- **Add Playwright as a dependency of the kit.** Rejected. Agent-kit takes no runtime dependency, and a Portable skill must carry everything it uses. A repository that wants the driver installs Playwright itself.

## Consequences

- **Harness browsers stay as the fallback.** Step 4 prefers `web.mjs` for a `web` scenario when readiness found Chromium; otherwise, or when the driver exits 2, the run uses the harness's browsers exactly as before. A scenario whose **Observes:** the driver cannot see falls through to the next driver.
- **The capture rules move into the driver.** A still is withheld while a password field holds a value, or while a sign-in value is in a field or on the screen, and its record says why. A field filled from a sign-in value shows dots (best-effort in a video), and the value never appears in the step file, the summary or a caption. A video cannot withhold a moment, so a sign-in value the page itself shows is in it; it stays local with every other QA Artifact.
- **The step record is a contract.** `{session, index, caption, still, subject, text, atMs, withheld}`, documented in manual-qa's `ADAPTER.md`, is what later evidence built from a run ([#235](https://github.com/mnaimfaizy/agent-kit/issues/235), [#236](https://github.com/mnaimfaizy/agent-kit/issues/236)) reads.
- **It runs on any harness with a shell.** The driver is `node` from the shell, so Cursor and headless CLIs can drive `web` without a browser of their own, once the repository has Playwright.
- **The tests that need Chromium skip without it.** CI installs nothing new; `AGENT_KIT_REQUIRE_CHROMIUM=1` turns the skip into a failure where Chromium must be there.
