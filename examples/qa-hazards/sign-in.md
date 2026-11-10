---
when: ["backend/auth/**", "**/*session*", "**/*login*", "**/*Login*"]
---

# Sign-in hazards

> Sample Hazard pack from Agent-kit's `examples/qa-hazards/`. Copy it into your repository (the path your `qa.config.yml` names under `hazards`), set the `when:` globs to your own sign-in code, and rewrite both lists for your product. The copy is yours. Guide: [docs/qa.md](../../docs/qa.md#hazard-packs).

`qa-plan` copies the _Rule out first_ list into each scenario that touches a path these globs match, and inlines the _Capture rules_ into the plan's Run brief. `manual-qa` obeys the capture rules while it runs the plan.

## Rule out first

- A session left over from an earlier scenario or run: sign out first, or use a fresh browser profile.
- A QA Account changed by an earlier scenario (a new password, a locked account): restore the role with `accounts.restore` before deciding the change broke sign-in.
- A cached page from before the build under test: hard-reload, and check the build against the plan's head.
- Sign-in rate limiting from repeated attempts: wait out the limit, or restart the QA Stack.
- The wrong role: check the signed-in user shown on screen matches the scenario's **Signs in as**.

## Capture rules

- Never capture the password field while it is filled, or a screen showing a one-time code, recovery code or token.
- Crop the browser's address bar out of screenshots taken after sign-in: a redirect can carry a code in the URL.
- Never save a HAR or network log of the sign-in request; describe what was sent in the report instead.
- A screenshot may show a QA Account's email (`*.test`) and role, and nothing else about the account.
