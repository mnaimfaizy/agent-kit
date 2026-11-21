---
status: accepted
---

# Run Records go to a private sink, and raw run folders only to an expiring bucket

A **Run Record** is always written locally, to `<run_dir>/records/<run-id>.json`, outside the run folder, so pruning a run folder never deletes it. Off the machine, a Consumer may set one sink for Run Records and a separate one for raw run folders. The Run Record sink is `github` (a private repository, written with `gh api`), `gitlab` (a private project, written with `glab api`) or `s3` (any S3-compatible bucket, signed with SigV4 from `node:crypto`). The raw-folder sink can only be `s3`. Run Records are kept indefinitely. Raw folders off the machine expire after about 30 days, through the bucket's own lifecycle rule. Pruning local run folders is opt-in, with 90 days offered.

Recorded in [#395](https://github.com/mnaimfaizy/agent-kit/issues/395), on the research in [#392](https://github.com/mnaimfaizy/agent-kit/issues/392) and the hand-derived records of [#393](https://github.com/mnaimfaizy/agent-kit/issues/393), on the wayfinder map [#391](https://github.com/mnaimfaizy/agent-kit/issues/391).

The skill runs in any Consumer's repository, with Node built-ins and the tracker CLI only, so a sink must be reachable without an SDK or new tooling. A Run Record holds only fields that are safe to publish, but a raw run folder may quote private issue text, command output and file contents. Git keeps every commit, so a git sink cannot honour any expiry: it suits records that are kept forever anyway, and it can never hold a raw folder. Only a bucket's server-side lifecycle rule deletes data after N days without the skill's help, even after the machine that uploaded it is gone.

## The rules

- **One sink, many repositories.** Every path is namespaced by the repository and the operator: `records/<host>/<owner>/<repo>/<login>/<run-id>.json` and `raw/<host>/<owner>/<repo>/<login>/<run-id>/<path>`, every segment lowercased. Without the host, a GitHub and a GitLab `acme/widgets` would collide. The repository is read from the git remote and can be pinned in the config, so a renamed or mirrored repository keeps its namespace. Records are never moved between namespaces. `<login>` is the tracker CLI's login, overridden only through the environment, never in the committed config.
- **Uploads are create-only.** An object that already exists with identical bytes counts as already uploaded, so a repeated `--upload <run>` is safe. An object with different bytes stops the upload. Nothing is ever overwritten. A `409` from parallel Contents API writes to one branch is retried.
- **Sinks are private.** A `github` repository or `gitlab` project that is not private is refused, checked at every upload, since visibility can change. No setting overrides this.
- **Off-machine retention belongs to the sink, not to the repository.** A bucket shared by many repositories has one lifecycle configuration, and per-repository keys would fight over it. Its owner sets the rule that expires `raw/`. The skill never writes bucket configuration, so its key needs only object read and write. Before a raw upload, the skill reads the bucket's lifecycle. It uploads nothing when no rule expires `raw/`, or when the lifecycle cannot be read, and the disclosure quotes the days the rule gives. A Consumer whose policy requires shorter retention for Run Records adds a `records/` rule to its own `s3` sink.
- **Only local pruning is a repository setting.** It covers closed-out run folders only, never `records/`.
- **A raw folder needs its own yes at every close-out.** It is never a routine write and never a config default. The Run Record upload can be approved once as a routine write in the Dispatch Plan.

## Considered Options

- **GitHub Actions artifacts.** Rejected. They cannot be uploaded from a CLI, and their retention is capped at 90 days (400 in a private repository), which conflicts with keeping Run Records indefinitely.
- **Gists.** Rejected. A secret gist is not private, and a gist is owned by one user, not a team.
- **Tracker attachments.** Rejected. They can only be uploaded through the web UI.
- **Raw folders on a git sink, even opted in.** Rejected. Git cannot expire them, and on a public repository they would be published.
- **Per-repository retention keys (`records_days`, `raw_days`).** Rejected. In a shared sink they conflict with each other, and on a git sink they cannot be honoured.
- **The skill setting the bucket's lifecycle rule.** Rejected. It would need a key that can change bucket configuration, and repositories sharing a bucket would overwrite each other's rules.
- **Paths without the host (`records/<owner>/<repo>/…`).** Rejected. Repositories on different hosts with the same name would collide.

## Consequences

- **Other storage is a doc hint, not a promise.** Any S3-compatible store (AWS S3, R2, GCS with HMAC keys, Backblaze B2, MinIO, Wasabi, DigitalOcean Spaces) should work as `s3` with its own endpoint, but is untested. Azure Blob, Bitbucket, Gitea and Forgejo are not sinks: a Consumer keeps Run Records local, or asks for a sink.
- **The `gitlab` sink ships at Support Level `documented`,** like the GitLab tracker, until a run has uploaded to it. GitLab does not document whether creating a file that already exists fails, so the sink reads the path before it creates the file.
- **Uploads stop for anyone without a login.** A Consumer with no `gh` or `glab` login and no environment override keeps Run Records local.
