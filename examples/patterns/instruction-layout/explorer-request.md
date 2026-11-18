<!--
Pattern guide skeleton: docs/patterns/instruction-layout.md in Agent-kit.
The shape of the request the main agent sends to the explorer. Keep it next to
the explorer's agent body, adapt the fields, and delete this comment.
-->

# Explorer request

Only the goal is required. Leave out a field you have nothing for.

```markdown
## Explorer request

### Goal

One sentence: the question to answer.

### Known locations

Files or folders you already suspect.

### Search hints

Symbol names, patterns or terms to search for.

### Supplied evidence

The output of commands you ran for the explorer, which has no shell, such as
a dependency graph query or a list of changed files. Name each command.

### Depth

`quick` or `thorough`. Without it: `thorough` when the goal asks for every or
all of something, `quick` otherwise.

### Out of scope

What not to spend time on.

### Expected output

Which sections of the explorer summary matter most for this request.
```

## A filled request

```markdown
## Explorer request

### Goal

Which modules read the session timeout, and where is its default set?

### Search hints

`sessionTimeout`, `SESSION_TIMEOUT`

### Depth

thorough

### Out of scope

Test fixtures.
```
