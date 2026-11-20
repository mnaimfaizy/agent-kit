# Where to keep Run Records off the machine, and for how long

Research for wayfinder ticket [#392](https://github.com/mnaimfaizy/agent-kit/issues/392) on map [#391](https://github.com/mnaimfaizy/agent-kit/issues/391): where a Consumer of `orchestrate` can keep **Run Records** (and, opted in, raw run folders) off their machine, and what retention to ship as the default.

The constraints every option is judged against:

- `orchestrate` is a portable skill installed in any Consumer's repository. Its scripts use only Node built-ins and the `gh` CLI: no SDKs, no `aws`, `gcloud` or `wrangler`.
- A Run Record is small, redacted, structured JSON: counts, ids, durations, outcomes, each human intervention with its kind, never quoted issue text or command output (map #391, standing rules).
- A raw run folder is a few hundred KB to a few MB (this repository's `tmp/orchestrate/` holds 8 runs in 3.9 MB, the largest 1.8 MB) and may quote private issue text. It leaves the machine only on a separate, explicit opt-in.
- It must work for an individual and for a team.
- Settled on the map already: Run Records are kept indefinitely; local pruning of raw folders is opt-in with a default of 90 days.

Reading notes:

- **Read on:** 2026-11-21. Docs pages carry no publish date, so a fact from one is dated by the read.
- **Sources:** primary only (vendor docs, the GitHub docs, the local `gh` help). `gh version 2.102.0 (2026-09-30)`.
- **Nothing was created**: no bucket, gist, artifact, repository or file was made to test a claim.
- **UNCONFIRMED** marks anything no primary source states; each is listed again at the end.
- The ticket asked to read the "Run Record" entry in `GLOSSARY.md`. `origin/main` has no such entry yet; the definition used here is the map's.

## 1. The candidate sinks

### A. Object storage with lifecycle rules (S3, R2, GCS)

**Retention controls.** All three delete objects by age, server side, with a prefix filter, so a sink can hold `records/` forever and expire `raw/` after N days with no client-side pruning.

- **S3:** an `Expiration` action deletes objects "at the end of their lifetime"; a rule added later also applies to existing objects; "There may be a delay between the expiration date and the date at which Amazon S3 removes an object. You are not charged for expiration or the storage time associated with an object that has expired." A lifecycle rule cannot be blocked by a bucket policy. ([S3 expiring objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html))
- **R2:** rules delete "after a set number of days", per prefix, up to 1,000 rules a bucket; objects are typically removed "within 24 hours of the `x-amz-expiration` value"; deleted objects stop billing. Rules can be set through the S3 API (`PutBucketLifecycleConfiguration`, endpoint `https://<account_id>.r2.cloudflarestorage.com`, region `auto`). Every bucket has a default rule that aborts multipart uploads after 7 days. ([R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/), [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/))
- **GCS:** a `Delete` action with an `age` condition (days since upload) and `matchesPrefix`; actions are asynchronous ("Your applications shouldn't rely on lifecycle actions occurring within a certain amount of time"); config changes take up to 24 hours. Deleted objects are soft-deleted for 7 days by default. Storage is still billed between the condition being met and deletion unless the rule is `age`-only and soft delete is off. ([GCS lifecycle](https://docs.cloud.google.com/storage/docs/lifecycle))

**Auth a Node-built-ins script can use.** All three accept AWS Signature Version 4 (S3 natively; R2 through its S3 API; GCS through HMAC keys on the XML API, which sign with HMAC-SHA256 ([GCS HMAC keys](https://docs.cloud.google.com/storage/docs/authentication/hmackeys); that it is exactly SigV4 is **UNCONFIRMED** from that page)). AWS recommends an SDK "Unless you have a good reason not to", but documents manual signing for custom code: a canonical request, a derived signing key, an `Authorization` header or a query string ([IAM SigV4](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv.html)). That is HMAC-SHA256 and SHA-256 only, which `node:crypto` provides, and `fetch` sends. Two ways to fit the skill:

1. **Presigned PUT URL** (no secret held by the skill): a presigned URL lets someone "upload a specific object ... without requiring another party to have AWS security credentials"; via CLI/SDK it lasts up to 7 days, and it dies early with the credentials that signed it ([S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)). R2: SigV4, "1 second to 7 days", GET/PUT/HEAD/DELETE, "Treat presigned URLs as bearer tokens" ([R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)). Because it is per object key and expires in at most 7 days, it does not fit "upload at every close-out" without someone minting a URL each time.
2. **Access key in the environment, signed by the script** with `node:crypto`: one key pair scoped to one bucket. Works unattended; the skill must never write the secret to the config or the run folder.

**Cost.** R2 Standard: $0.015 per GB-month, with 10 GB-month, 1 M Class A and 10 M Class B operations free each month, and "no charges for egress bandwidth" ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)). For records of a few KB, and raw folders of a few MB expiring after weeks, a Consumer stays inside R2's free tier (estimate). S3's per-GB price was not in the fetched page text (**UNCONFIRMED** here); its GET price is $0.0004 per 1,000, and new accounts get credits rather than an S3 free tier ([S3 pricing](https://aws.amazon.com/s3/pricing/)).

**Privacy and teams.** A bucket is private unless made public. A team shares one bucket, each teammate writing `records/<login>/<run-id>.json`, so no two writers touch one key. Setting it up needs a cloud account, a bucket, a key and a lifecycle rule: real friction for an individual, normal for a team.

### B. A data branch, or a separate repository, written through `gh api`

**Auth:** the `gh` token the skill already uses. `PUT /repos/{owner}/{repo}/contents/{path}` creates or updates a file in one call, with a `branch` parameter; an update needs the old blob `sha`; the docs say not to run it in parallel with "Delete a file" because "the concurrent requests will conflict" ([Contents API](https://docs.github.com/en/rest/repos/contents)). Reading back works to 1 MB per file normally, to 100 MB with the `raw` media type. The endpoint documents no file size limit for writes (**UNCONFIRMED**); git itself warns at 50 MiB and GitHub blocks files over 100 MiB, and repositories should be "ideally less than 1 GB, and less than 5 GB is strongly recommended" ([large files](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)).

**Size headroom.** At a few KB a record, 1 GB is hundreds of thousands of Run Records (estimate), so indefinite retention of records fits.

**Retention controls: none.** Git keeps every commit. Deleting a file removes it from the tip, not from history, so a repository sink cannot honour "delete after N days" for anything it was given. That rules it out for raw folders, and makes it a natural home for records that are kept indefinitely anyway.

**Privacy.** A data branch inherits the repository's visibility: in a public Consumer repository, every record on it is public. A record is redacted and safe to publish by design (map #391), but a Consumer may still not want it published, so the default should be a **separate private repository** (or a data branch only when the Consumer repository is private). Access for a team is the repository's own collaborator list.

**Teams.** Each teammate writes their own path (`records/<login>/<run-id>.json`), so creates never collide on a file. One commit per record; whether parallel creates of _different_ files on one branch can still fail on the ref update is **UNCONFIRMED** (the docs warn only about update-vs-delete). A retry on `409` covers it.

**Cost:** none for the storage itself.

### C. GitHub Actions artifacts

- **Cannot be uploaded from a CLI.** The REST API lists, gets, downloads and deletes artifacts; it has no upload endpoint ([artifacts API](https://docs.github.com/en/rest/actions/artifacts)). Upload happens only inside a workflow run (`actions/upload-artifact`). A skill could relay a record through `workflow_dispatch`, but inputs are capped at 25 properties and "65,535 characters" ([events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)), which rules out raw folders and requires adding a workflow file to the Consumer's repository.
- **Retention is capped**: default 90 days; 1 to 90 days in public repositories, 1 to 400 in private; changes are not retroactive ([retention](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization)). That contradicts the settled "Run Records kept indefinitely".
- **Quota**: shared with Packages, 500 MB on Free, 1 GB Pro, 2 GB Team, then $0.25 per GB-month ([Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).
- Download needs read access to the repository ([download artifacts](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)); `gh run download` reads them.

Verdict: a poor sink for either payload.

### D. Gists

- `gh gist create` makes secret gists by default (**gh help**), but "Secret gists aren't private": anyone with the URL can view one, and GitHub points to a private repository for confidentiality ([creating gists](https://docs.github.com/en/get-started/writing-on-github/editing-and-sharing-content-with-gists/creating-gists)).
- Gists are owned by a user (`/users/{username}/gists`); no org ownership is documented, so a team cannot share one store with shared access (inferred, **UNCONFIRMED**). The API returns at most 1 MB of content per file and the first 300 files ([gists API](https://docs.github.com/en/rest/gists/gists)).
- No retention controls.

Verdict: acceptable for an individual's records only, never for raw folders; strictly worse than a private repository.

### E. Tracker attachments (issue comment uploads)

Attachments are added by drag and drop or the paperclip in the web UI, up to 25 MB for most files, `.json` and `.zip` allowed; on a private repository only people with access can view them ([attaching files](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)). No REST or `gh` route to upload one is documented (**UNCONFIRMED** as an absence). A comment body itself is limited (65,536 characters is the widely reported, undocumented figure; **UNCONFIRMED**) and is public on a public repository.

Verdict: not scriptable; drop it.

### Summary

| Sink                                    | Auth with Node + `gh`                      | Retention control               | Raw folders            | Private by default             | Individual   | Team                | Cost                   |
| --------------------------------------- | ------------------------------------------ | ------------------------------- | ---------------------- | ------------------------------ | ------------ | ------------------- | ---------------------- |
| Local `run_dir`                         | none needed                                | the skill's own pruning         | yes                    | yes                            | yes          | no                  | none                   |
| Private repo / data branch via `gh api` | `gh` token                                 | none (git history)              | **no**                 | if the repo is private         | yes          | yes (collaborators) | none                   |
| R2 / S3 / GCS                           | SigV4 with `node:crypto`, or presigned URL | server-side lifecycle by prefix | **yes**                | yes                            | with setup   | yes                 | R2 free tier covers it |
| Actions artifacts                       | none (workflow only)                       | capped 90 / 400 days            | no (65,535-char relay) | repo visibility                | no           | no                  | quota                  |
| Gist                                    | `gh` token                                 | none                            | no                     | **no** (secret is not private) | records only | no                  | none                   |
| Issue attachment                        | none (web UI)                              | none                            | no                     | repo visibility                | no           | no                  | none                   |

## 2. What retention current practice uses

Trace and log backends keep **raw** traces for weeks and **aggregates or run metadata** for a year or more:

| Tool                        | Raw traces / events                                                                                                                                    | Longer-lived data                                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LangSmith Cloud             | base tier 14 days                                                                                                                                      | extended tier 180 days by default for traces ingested from 2026-09-14 (earlier traces keep their old retention, 400 days); upgraded by feedback with `extend_trace_retention=true`, online evaluators or automation rules ([usage and billing](https://docs.langchain.com/langsmith/usage-and-billing)) |
| Langfuse                    | self-hosted: "stored indefinitely by default"; Cloud plans limit the _access_ window (Hobby 30 days, Core 90, Pro/Enterprise 3 years) without deleting | per-project retention, minimum 3 days, nightly deletion, "Deleted assets cannot be recovered" ([data retention](https://langfuse.com/docs/administration/data-retention))                                                                                                                               |
| Honeycomb                   | events and logs: "60-day fixed retention", counted from ingestion                                                                                      | metrics: 13 months by default ([usage](https://docs.honeycomb.io/get-started/manage-costs/how-honeycomb-calculates-usage.md))                                                                                                                                                                           |
| Datadog                     | indexed spans: 15 or 30 days by plan                                                                                                                   | CI Pipeline Visibility (pipelines, jobs, commands): 15 months ([retention periods](https://docs.datadoghq.com/data_security/data_retention_periods/))                                                                                                                                                   |
| Grafana Tempo (self-hosted) | compactor `block_retention` default 336h (14 days) ([Tempo config](https://grafana.com/docs/tempo/v1.2.x/configuration))                               | none                                                                                                                                                                                                                                                                                                    |
| GitHub Actions              | run logs and artifacts: 90 days default                                                                                                                | none                                                                                                                                                                                                                                                                                                    |

OpenTelemetry itself defines no retention; it is a property of each backend (no OTel page states a default; inferred).

General guidance:

- **OWASP Logging Cheat Sheet:** never log secrets, tokens or sensitive personal data; logs "must not be destroyed before the duration of the required data retention period" and "must not be kept beyond this time"; periods come from legal, regulatory and contractual obligations. It names no durations ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)).
- **GDPR Recital 39:** the storage period should be "limited to a strict minimum", and "time limits should be established by the controller for erasure or for a periodic review" ([Regulation 2016/679](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng)). Relevant because a raw folder may quote issue text naming people; a Run Record, holding ids and counts only, is the minimised form.
- **NIST SP 800-92** (Final, 2006) is the standard log-management guide; its landing page states no durations ([NIST](https://csrc.nist.gov/pubs/sp/800/92/final)); the full PDF was not read.

The pattern maps directly onto orchestrate: a Run Record is the redacted, aggregate-like run metadata (the Datadog CI Visibility / Honeycomb metrics row), and a raw run folder is the raw trace (the 14 to 60 day row).

## 3. Recommendation

### Default sink set

1. **`local` (the default, always on).** Run Records stay under `run_dir` with the run. Nothing leaves the machine until a sink is configured and the disclosure shown. Reason: the map's standing rules; no credentials; works everywhere.
2. **`github` sink for Run Records: a separate private repository, written with `gh api` Contents calls**, path `records/<login>/<run-id>.json`, a data branch in the Consumer repository allowed only when that repository is private. Reasons: the only off-machine store the skill can reach with the `gh` token it already has ([Contents API](https://docs.github.com/en/rest/repos/contents)); free; private access is the repository's collaborator list, so it serves a team as well as an individual; per-login paths mean no two writers share a file; records of a few KB fit inside the 1 GB guidance for hundreds of thousands of runs ([large files](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)); and git's lack of expiry matches the settled indefinite retention. A dashboard reads it with the same `gh api`.
3. **`s3` sink (S3-compatible: R2, S3, GCS XML), opt-in, the only sink allowed raw folders.** Signed with SigV4 from `node:crypto`, key from the environment, never from the config; one bucket, prefixes `records/` and `raw/`. Reasons: server-side lifecycle expiration by prefix is the only retention control that deletes without the skill's help, even after the machine is gone ([S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html), [R2](https://developers.cloudflare.com/r2/buckets/object-lifecycles/), [GCS](https://docs.cloud.google.com/storage/docs/lifecycle)); private by default; R2's free tier and free egress make it free at this volume ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)). Name R2 as the suggested provider for a Consumer without one.
4. **Not offered:** Actions artifacts (no CLI upload, retention capped at 90/400 days, quota ([1](https://docs.github.com/en/rest/actions/artifacts), [2](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization))); gists ("Secret gists aren't private", user-owned ([1](https://docs.github.com/en/get-started/writing-on-github/editing-and-sharing-content-with-gists/creating-gists))); tracker attachments (web UI only ([1](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files))).

**A raw folder never goes to the `github` sink**, even opted in: git cannot expire it, and on a public repository it would be published. The config check should refuse that combination.

### Default retention

- **Run Records: indefinite** on every sink (as settled). Reasons: redacted, a few KB each, and the kind of data current practice keeps longest (Datadog keeps CI pipeline execution metadata 15 months; Honeycomb keeps metrics 13 months; self-hosted Langfuse keeps everything by default ([1](https://docs.datadoghq.com/data_security/data_retention_periods/), [2](https://docs.honeycomb.io/get-started/manage-costs/how-honeycomb-calculates-usage.md), [3](https://langfuse.com/docs/administration/data-retention))). Team trends and the dashboard need history. Offer an optional `records_days` for Consumers whose policy says otherwise; on an `s3` sink it becomes a lifecycle rule on `records/`.
- **Raw folders uploaded off the machine (opt-in): 30 days**, set as a lifecycle `Expiration` on the `raw/` prefix when the sink is configured. Reasons: raw traces in the tools above live 14 to 60 days (LangSmith base 14, Tempo 14, Datadog 15/30, Honeycomb 60 ([1](https://docs.langchain.com/langsmith/usage-and-billing), [2](https://grafana.com/docs/tempo/v1.2.x/configuration), [3](https://docs.datadoghq.com/data_security/data_retention_periods/), [4](https://docs.honeycomb.io/get-started/manage-costs/how-honeycomb-calculates-usage.md))), and 30 is inside that range; a raw folder may quote private issue text, so the off-machine copy, which more people can reach, should not outlive the local one (90 days); GDPR asks for the strict minimum with a set erasure time ([Recital 39](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng)); and the folder's use, debugging a run that went wrong, is over within weeks. Lifecycle deletion is asynchronous (up to about a day late on R2 and S3, unspecified on GCS), so the disclosure should say "deleted after about 30 days", not "on day 30".
- **Raw folders on the machine: 90 days, opt-in** (as settled), matching the GitHub Actions log default ([retention](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization)).

## UNCONFIRMED

- That GCS HMAC signing on the XML API is exactly AWS SigV4 (the HMAC page says HMAC-SHA256 and S3 code reuse, not SigV4 by name).
- S3 Standard's per-GB-month price (not in the fetched page text).
- A size limit on writes through the Contents API (none documented).
- Whether parallel creates of different files on one branch through the Contents API can fail on the ref update (only update-vs-delete is warned).
- That gists cannot be owned by an organization (inferred from user-only endpoints).
- That no API uploads an issue attachment (an absence: no route is documented).
- The 65,536-character issue-comment body limit (widely reported, undocumented).
- That OpenTelemetry defines no retention default (inferred: retention is a backend property).
- NIST SP 800-92's text on retention (only the landing page was read).
- All sizes and record counts marked "estimate" (a Run Record's shape is not yet specified).
