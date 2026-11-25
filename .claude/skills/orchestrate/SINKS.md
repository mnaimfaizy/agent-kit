# Run Record sinks

A **Sink** is a store off the machine that receives Run Records. `local` is always on: the record is written to `<run_dir>/records/<run-id>.json`. One more sink may be set in the config's `records.sink` ([CONFIG.md](CONFIG.md#records)); the upload at close-out and `--upload <run>` write to it through the operations below, and only these. How each one is done on one sink is in that sink's own file under [sinks/](sinks/): load only the file for the sink the config names.

| Operation    | Kind  | What it gives                                                                                                    |
| ------------ | ----- | ---------------------------------------------------------------------------------------------------------------- |
| `visibility` | read  | Whether the sink is private. Run before every read and write; anything but private is refused, with no override. |
| `access`     | read  | How many people can read the sink, for the disclosure. Left out of the disclosure when it cannot be read.        |
| `read`       | read  | The bytes at one path, or that the path is not there.                                                            |
| `create`     | write | Create one file at a path, and nothing else: it never changes or deletes one.                                    |
| `list`       | read  | Every path under a prefix, for the dashboard.                                                                    |

`sinks/<sink>.md` is named for a value of `records.sink.type`. It opens with these bullets, each on its own line in this form:

- `- **Id:** \`<sink>\``, the file's own name.
- `- **Support Level:** \`<level>\``, then what it rests on, in the vocabulary harness files use ([HARNESSES.md](HARNESSES.md#support-level)).
- `- **Facts from:**` where and when each fact was read.

Then a `## Access` section giving the writer's access and the reader's, a `###` section for each operation above, headed with its name in backticks, giving the command and how to read its output, and a `## Check before use` section for every fact no run has confirmed yet.

**The path** is `records/<host>/<owner>/<repo>/<login>/<run-id>.json`, every segment lowercased: the host keeps different forges apart, so two repositories never collide in one shared sink, even with one run id or one login. `<host>/<owner>/<repo>` is `records.repository`, or the `origin` remote (or the only remote; with several and none named `origin`, the run asks which). `<login>` is the tracker login, which is also the record's `run.operator`, overridden only by `ORCHESTRATE_OPERATOR`; with no login, nothing is uploaded.

**The dashboard reads through the same operations:** `visibility` first, then `list` under `records/`, then `read` of each path its cache lacks, so a sink type is written once. It needs read access only, and reads the namespaces from the paths, since there is no index file. A sink that cannot be read is a warning on the page, never a failure.

**The write is create-only.** Identical bytes already at the path count as already uploaded; different bytes stop the upload; a parallel-write conflict is retried.

Sinks beyond `github` are later work: `gitlab` and `s3` each get a file here when they land.
