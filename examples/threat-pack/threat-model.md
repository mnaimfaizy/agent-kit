# Threat model

Threat pack for the Agent-kit security audit of this repository. The audit reads this file before it walks the code (`threat_model_path` in the security audit Caller). It reports only Medium or higher findings that are reachable through a path described here or an equally concrete one, so the more precise this file is, the better the audit.

> Skeleton from Agent-kit's `examples/threat-pack/`. This copy is yours: fill in every section, delete the guidance in italics, and review it before the first audit.

## Scope

_What the audit covers (product code, services, CI, infrastructure as code) and what it does not. Name the folders._

## Assets

| Asset                                           | Where                                   | Why it matters                              |
| ----------------------------------------------- | --------------------------------------- | ------------------------------------------- |
| _Example: user session tokens_                  | _`src/auth/`, the `sessions` table_     | _Account takeover if leaked or forged_      |
| _Example: the production database credentials_  | _CI secret `DATABASE_URL`, deploy step_ | _Full read and write access to user data_   |
| _Example: release artifacts and the build pipe_ | _`.github/workflows/release.yml`_       | _Whoever controls them ships to every user_ |

## Trust boundaries

_Where data or control crosses from less trusted to more trusted. One line each: what crosses, and what checks it._

1. _Example: **Internet → API.** Every request is untrusted until the auth middleware has verified the session._
2. _Example: **Pull request → CI.** Fork pull requests run without secrets._

## Attack paths to walk

_The concrete ways an attacker could reach an asset across a boundary. The audit walks each one._

- _Example: **Injection**: user input reaching SQL, shell, template or path APIs without the shared validator._
- _Example: **Authorization**: an endpoint that loads a record by id without checking that the caller owns it._
- _Example: **Secrets**: a credential reachable from logs, error messages, client bundles or a workflow step that runs pull request code._
- _Example: **Supply chain**: a dependency or third-party action not pinned to a version or commit._

## Out of scope

_What the audit should not report, and why (accepted risks, third-party services, test fixtures)._
