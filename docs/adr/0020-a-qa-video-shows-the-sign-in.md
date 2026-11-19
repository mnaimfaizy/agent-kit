---
status: proposed
---

# A QA video shows the sign-in

A scenario's MP4 tells its story as a person doing the QA would see it. So each Session's first **Scene** plays from the start of that Session's recording, and the sign-in plays on camera. Masking is best-effort. A field filled from a `{{env:QA_…}}` placeholder shows dots, and is typed in one go, not key by key. A sign-in value the page shows by itself, such as an account's email in a header, is visible. The person decides whether the video leaves `working_dir`. When they pick an MP4 that plays a sign-in, `report.mjs evidence` warns them and names the roles. It never blocks the upload.

Recorded in [#377](https://github.com/mnaimfaizy/agent-kit/issues/377).

This is a real trade-off against the rule for stills. `web.mjs` withholds any still while a sign-in value is on the screen, and a video cannot withhold a moment. The alternative was to open each Session on its first step after sign-in, with the **Title card** saying the person is signed in. That keeps the sign-in out of every video, but the story then starts mid-flow and no longer reads as a person using the product. The video stays a local QA Artifact by default, on a test system with QA Accounts whose values are public fixtures. So the person who chooses to upload it carries the residual risk, and the warning tells them about it.

## Consequences

- **A still and a video follow different rules.** A Storyboard row can still be a withheld frame while the MP4 shows the same moment. Nobody should "fix" one to match the other without revisiting this ADR.
- **An uploaded MP4 can't be taken back.** A video already attached to a ticket or release keeps its sign-in, so tightening this later only protects future runs.
- **A `url` target raises the stakes.** Its accounts may not be fixture QA Accounts, which is why the upload warning names the roles the video signs in as.
