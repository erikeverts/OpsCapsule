# Agent profile manifests

This document defines the agent profile manifest contract implemented in
Iteration 4. Existing `target.agentRuntime` declarations remain readable as a
compatibility path.

The design keeps agents and model providers independent. An agent profile says
how to prepare and launch an interactive agent CLI. A target still says which
directories, cloud identity, Kubernetes context, isolation policy, and network
policy the process receives.

## Example

```yaml
apiVersion: opscapsule.dev/v1alpha1
kind: Workspace

metadata:
  id: example
  name: Example workspace

agentProfiles:
  - id: opencode-bedrock
    name: OpenCode on Bedrock
    adapter: opencode
    runtime:
      command: opencode
      args: []
    configuration:
      files:
        - source: resources/agents/opencode-bedrock/opencode.json
          destination: .config/opencode/opencode.json
        - source: resources/agents/opencode-bedrock/tui.json
          destination: .config/opencode/tui.json
    environment: {}

  - id: custom-agent
    name: Custom agent command
    adapter: command
    runtime:
      command: custom-agent
      args:
        - --interactive
    configuration:
      files: []
    environment:
      CUSTOM_AGENT_MODE: interactive

defaultAgentProfile: opencode-bedrock

directories:
  - id: application
    name: Application repository
    path: /path/to/application
    access: read-write

cloudConnections:
  - id: aws-development
    name: AWS development
    provider: aws
    config:
      authentication:
        type: profile
        profile: example-development
      expectedIdentity:
        accountId: "111122223333"
      defaults:
        region: eu-west-1

kubernetesContexts: []

targets:
  - id: development
    name: Development
    environment: development
    risk: development
    cloudConnection: aws-development
    directories:
      - application
    defaultDirectory: application
    isolation:
      mode: enforced
      network:
        mode: public
        allowedDomains: []

  - id: production
    name: Production
    environment: production
    risk: production
    agentProfile: custom-agent
    directories:
      - application
    defaultDirectory: application
    isolation:
      mode: enforced
      network:
        mode: allowlist
        allowedDomains:
          - api.example.com
```

The development target inherits `opencode-bedrock`; production overrides it with
`custom-agent`. A target does not need an override when it uses the workspace
default.

## Fields

### `agentProfiles`

An optional workspace-level array of reusable profiles. Profile ids use the same
stable, lowercase, hyphenated identifiers as other workspace resources and must
be unique.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Stable reference used by defaults, targets, resources, and state. |
| `name` | yes | Human-readable label. |
| `adapter` | yes | Adapter registry id. Initial values are `opencode` and `command`. |
| `runtime.command` | yes | Executable name or absolute executable path. |
| `runtime.args` | no | Literal argument list; defaults to `[]`. |
| `configuration.files` | no | Managed files staged below the synthetic home; defaults to `[]`. |
| `environment` | no | Explicit non-secret string values; defaults to `{}`. |

The adapter id is an open identifier rather than a closed enumeration. This lets
future adapters be added without changing the core manifest shape. An unavailable
adapter is a readiness error, not a YAML parse error.

`runtime.command` is not interpreted by a shell. Arguments remain separate values,
which avoids quoting ambiguity and command injection. `$SHELL` remains meaningful
only for the legacy target runtime and the generic command compatibility path; it
is not a useful managed agent command.

Environment variable names must match `[A-Za-z_][A-Za-z0-9_]*`. Values are always
strings and are stored as plaintext. Secrets, shell substitutions, and references
to inherited host variables are not supported by this field. Variables controlling
the synthetic home, temporary storage, agent state, Kubernetes context, AWS
identity, and `OPSCAPSULE_*` context are reserved and cannot be overridden.

### `configuration.files`

Each file mapping contains:

| Field | Required | Meaning |
| --- | --- | --- |
| `source` | yes | Workspace-relative managed resource path. |
| `destination` | yes | Relative path below the capsule's synthetic home. |

Both paths use `/` separators in the portable manifest. They must be normalized,
must not be absolute, and must not contain empty, `.` or `..` segments. Sources
must resolve beneath `resources/agents/<profile-id>/`; destinations must resolve
beneath the synthetic home. Canonical-path validation must reject a source that
escapes through a symbolic link. Duplicate destinations are invalid.

Destinations owned by OpsCapsule are reserved, including cloud and Kubernetes
identity paths and shell startup files. Adapters may further restrict destinations
to the locations supported by that agent. A mapping grants no additional host
filesystem access.

Workspace Studio may initially offer adapter-specific import choices, such as the
OpenCode settings and TUI files. It saves only managed paths; the original host
path is import-time information and is not retained as a runtime dependency.

### `defaultAgentProfile`

An optional workspace-level profile id. When present, it must reference an entry
in `agentProfiles`.

### `targets[].agentProfile`

An optional profile id that overrides `defaultAgentProfile` for one target. When
present, it must reference an entry in `agentProfiles`.

## Resolution and validation

For each target, OpsCapsule selects the target override first and then the
workspace default. While migrating existing manifests, `target.agentRuntime` is
used only when neither reference exists.

A manifest is invalid when:

- profile ids are duplicated;
- the workspace default or a target refers to an unknown profile;
- a target has neither a resolvable profile nor a legacy runtime;
- an environment variable name is invalid;
- a managed source or destination is unsafe; or
- two mappings in one profile write the same destination.

Adapter availability, executable resolution, and file existence are readiness
concerns because they depend on the machine running OpsCapsule. They do not make
the portable YAML structurally invalid.

## Managed and mutable paths

Portable configuration is stored with the workspace:

```text
config/workspaces/<workspace-id>/resources/agents/<profile-id>/
```

Mutable data is stored separately for every target/profile combination:

```text
state/workspaces/<workspace-id>/targets/<target-id>/agents/<profile-id>/
```

The adapter decides which of its data, cache, and session locations map into that
state root. No mutable state path is configurable as an arbitrary host path.

## Deliberately deferred

This iteration does not define:

- secret values or a credential broker;
- workspace metadata, reference documents, instructions, or curated memory;
- normalized MCP server resources or tool permissions;
- shared history across targets;
- agent plugin installation or synchronization;
- multiple simultaneous agent panes; or
- remote agent execution.

Those features can build on the same managed-resource and adapter boundaries
without expanding the first implementation's trust boundary. They remain
workspace context or tool resources rather than becoming agent-profile fields;
ADR 0005 records the intended separation.
