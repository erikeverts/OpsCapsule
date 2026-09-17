# ADR 0003: Workspace Studio and manifest persistence

- Status: Experimental
- Date: 2026-09-17

## Context

Iteration 2 made workspace manifests expressive enough to describe multiple
directories, cloud connections, Kubernetes contexts, and operational targets.
Editing those relationships directly in YAML is error-prone and makes the normal
workflow inaccessible to users who should not need to learn the manifest schema.

The manifest format must remain portable, inspectable, and suitable for future
version control. A UI-only database would create a second source of truth.

## Decision

OpsCapsule provides Workspace Studio as a form-based editor over the public YAML
manifest. YAML remains canonical. The renderer edits an in-memory typed draft and
shows a generated preview, but all persistence is performed by the main process
through a narrow IPC API.

The main process validates schema, references, and provider configuration before
writing. Existing documents carry a SHA-256 revision of the source bytes. Saving
requires that revision to still match the file on disk, preventing an external
edit from being overwritten silently. Replacements are written to a mode-0600
temporary file in the same directory and atomically renamed into place. New files
are created without overwriting an existing path.

Workspace ids are immutable after creation. Credentials are not part of the
editor model: cloud connections contain profile references and expected identity,
while Kubernetes connections contain kubeconfig references or generated public
connection data.

Running workspaces cannot be edited in this slice. This avoids removing or
renaming targets while their terminal sessions are active; saved changes take
effect on the next launch.

## Consequences

- Humans can create and maintain workspaces without writing YAML.
- Manifests remain transparent and editable by external tools.
- External edits are detected rather than lost.
- The renderer cannot choose arbitrary output paths or bypass validation.
- Comments and hand formatting are normalized when a manifest is saved through
  Workspace Studio. Comment-preserving YAML edits may be considered later.
- Provider discovery, connection tests, duplication, import/export, archival,
  and secret brokering remain future slices.
