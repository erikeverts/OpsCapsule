# Workspace context

Workspace context is what a workspace or target *knows*, as opposed to how it
is configured: a project code, a cost centre, the generated URL of an
environment. It is given to the agent so you do not have to repeat it, and
pinned entries appear in the sidebar so you do not have to go looking for them.

It holds two kinds of thing, delivered differently because they behave
differently: **facts**, which are small and almost always relevant, and
**documents**, which are large and occasionally relevant.

## This is not a secret store

Values are written to the manifest in plain text, shown in the interface, and
given to the agent. Keys that look like secrets are refused outright. Anything
confidential belongs in a [credential](credentials.md).

## Declaring entries

```yaml
context:
  metadata:
    - key: project-code
      value: DIP-1234
    - key: cost-center
      value: "55021"
    - key: argocd
      label: ArgoCD
      value: https://argocd.example.com
      pinned: true
targets:
  - id: development
    context:
      metadata:
        # Same key, different value: the per-environment URL.
        - key: argocd
          label: ArgoCD
          value: https://argocd-ri-obs-dev.example.com
          pinned: true
```

| Field | Meaning |
| --- | --- |
| `key` | Lowercase identifier, used by the agent and in `context.json` |
| `label` | Optional display name |
| `value` | The fact itself |
| `pinned` | Show it in the sidebar. A display choice only |

Whether an entry is a link is derived from its value, not declared. An `http`
or `https` value is opened in your browser; anything else is shown as text.
Asking for the kind separately only created a way to get it wrong, and getting
it wrong made an entry silently unclickable.

## Target-specific entries

A target entry with the same key as a workspace entry **replaces it** for that
target, which is what makes a per-environment URL one key rather than
`argocd-dev` and `argocd-prod` living side by side. A key that appears only on
a target is added for that target alone, which is the right shape for something
that genuinely exists in one environment.

Replacement is whole-entry, not field by field, so an override carries its own
label and pin. Workspace Studio offers **Override a workspace entry** under
each target, which adds the row prefilled from the workspace entry so only the
value needs changing. Writing YAML by hand, repeat the fields you want to keep:

```yaml
targets:
  - id: development
    context:
      metadata:
        - key: argocd
          label: ArgoCD      # repeated, or it is dropped for this target
          value: https://argocd-ri-obs-dev.example.com
          pinned: true
```

What the target resolves is what the sidebar shows and what the agent is given.
The workspace value is not mentioned anywhere in the capsule.

## What the agent receives

Every entry, inlined into the agent instructions beneath whatever you wrote:

```markdown
## Workspace context

Non-secret facts about this workspace and target.

- `project-code`: DIP-1234
- ArgoCD (`argocd`): https://argocd-ri-obs-dev.example.com

The same values are available as JSON at `$OPSCAPSULE_CONTEXT/context.json`.
```

Inlining is deliberate. Values are small, and the alternative is an agent that
has to decide to go and look, which in practice means it often will not. The
limit of twenty resolved entries exists for the same reason: every entry is
sent on every turn, so the cost is real even though it is small.

Documents will be listed rather than inlined, because a runbook cannot go in
every prompt. That difference is the whole reason the catalog exists.

The same values are written to `$OPSCAPSULE_CONTEXT/context.json` for scripts
in the shell panes:

```bash
jq -r '.metadata[] | select(.key == "argocd") | .value' "$OPSCAPSULE_CONTEXT/context.json"
```

Context is data. It grants no filesystem or network access, and nothing in it
can widen a capsule's isolation.

## Documents

Runbooks, architecture notes, statements of work. Attach one in Workspace
Studio under **Context → Documents**, or declare it in the manifest:

```yaml
context:
  documents:
    - id: incident-runbook
      title: Incident runbook
      description: What to do when the ingest pipeline stalls
      source: /Users/you/docs/runbook.md
```

On save the file is copied into the workspace, and `source` is rewritten to the
managed copy. The workspace holds its own snapshot, so a capsule never reaches
into wherever the original lives, and moving or deleting the original cannot
change what a target has already been given. Re-attach the file to pick up
changes.

A target may attach its own documents, and an identifier matching a workspace
document replaces it for that target — a production runbook in place of the
general one.

### What the agent receives

The catalog lists documents; it never includes them.

```markdown
## Workspace documents

Reference material for this workspace. Read one when it is relevant;
the contents are not included here.

- **Incident runbook** — What to do when the ingest pipeline stalls: `$OPSCAPSULE_CONTEXT/documents/incident-runbook.md`
```

The **description** is the only part of a document that costs context on every
turn, and it is what the agent uses to decide whether opening the file is worth
it. A document with a vague description is one the agent will not open.

Documents are delivered into the capsule read-only. Reference material is not
the agent's to edit, and a capsule must not be able to rewrite what the next
one is told.

| Limit | Value |
| --- | --- |
| Documents resolved per target | 20 |
| Size of one document | 25 MB |

Documents are referenced rather than inlined, so size costs disk and a copy at
launch rather than context on every turn. Real runbooks are exported from wikis
and carry images, and a tight limit would only push people back to pasting
excerpts.

Identifiers are generated from the filename and truncated to fit. Runbook names
routinely carry a document number and a full business unit name; the identifier
is shortened and the title keeps the whole thing.

## Pinned entries

Pinned entries appear in the sidebar for the selected target, with the name and
the value on separate lines, because a sidebar column is too narrow to show
both side by side.

Links open in your browser. Only `http` and `https` values are treated as
links, and the scheme is checked again in the main process when the link is
opened, so a shared manifest cannot turn a pinned entry into a way to run
something locally. A `javascript:` or `file:` value is not an error; it is
simply never clickable.

Pinning changes nothing about what the agent is told. It receives every entry
either way.
