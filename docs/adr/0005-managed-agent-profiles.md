# ADR 0005: Managed agent profiles

- Status: Proposed
- Date: 2026-09-18

## Context

OpsCapsule launches an agent process inside the same enforced boundary as the two
interactive shells. The boundary intentionally gives the capsule a synthetic home
directory instead of access to the user's real home. This prevents an agent from
silently reading unrelated customer data, but it also means that an agent cannot
see its normal configuration, provider selection, or mutable state.

The current manifest stores a generic command directly on every target. That is a
useful compatibility mechanism, but it duplicates configuration, cannot express a
workspace default, and gives OpsCapsule no safe way to prepare files or check an
agent before launch. Granting access to `~/.config`, `~/.local`, or the complete
home directory would undermine the isolation model. Copying those directories is
not safe either: they can contain credentials, conversation history, databases,
plugins, and executable hooks.

OpsCapsule must remain agent-agnostic and LLM-agnostic. Supporting an agent must
not require embedding its SDK or coupling the workspace model to one model
provider.

## Decision

The workspace manifest will define reusable, workspace-scoped `agentProfiles`.
A workspace can select a `defaultAgentProfile`, and a target can optionally select
a different profile with `agentProfile`. Selection is resolved in this order:

1. the target's `agentProfile`;
2. the workspace's `defaultAgentProfile`; and
3. during migration only, the target's existing `agentRuntime` as an implicit
   generic command profile.

An agent profile declares:

- a stable id and display name;
- an adapter id;
- a command and arguments;
- explicit, non-secret environment values; and
- zero or more managed configuration files with workspace-relative sources and
  synthetic-home-relative destinations.

The first adapter-specific integration will be `opencode`. The `command` adapter
remains the generic fallback for any interactive CLI. Adapters translate the
portable profile into process and filesystem preparation; they do not embed or
call an agent SDK. Unknown adapter ids remain representable but make a target
unavailable until an adapter is installed.

The proposed manifest contract is specified in
[`docs/agent-profiles.md`](../agent-profiles.md).

### Managed configuration

Workspace Studio imports only files explicitly selected by the user. Imported
files are copied beneath the workspace resource directory and the saved manifest
points at those managed copies:

```text
config/workspaces/<workspace-id>/
  workspace.yaml
  resources/
    agents/<profile-id>/
      opencode.json
      tui.json
```

Each destination is relative to the capsule's synthetic home. Absolute paths and
parent traversal are invalid, canonical sources cannot escape through symbolic
links, and destinations owned by OpsCapsule for target identity or shell setup are
reserved. Before launch, OpsCapsule copies the configured files into the synthetic
home with restrictive permissions. A profile cannot use configuration mappings to
expand its sandbox filesystem access or replace the selected target identity.

Managed configuration is a snapshot. Changes to the original host file are not
picked up until the user imports it again. The UI must show the source, destination,
and exact files that will be copied. Agent files can contain provider settings,
external tool declarations, or executable hooks, so an import requires inspection
and an explicit save even when it appears not to contain credentials.

OpsCapsule does not import credential stores, authentication files, history,
session databases, caches, plugins, or arbitrary configuration directories. In
particular, the first OpenCode slice will not copy `auth.json` or its data
directory. Static secrets do not belong in the manifest or managed configuration.
A future credential broker can provide secret-backed integrations without making
credentials portable workspace files.

### Environment and target identity

Only environment entries declared by the profile and the context prepared by the
selected target are passed to the agent. OpsCapsule does not copy arbitrary
variables from the host login shell. Literal profile environment values are stored
as plaintext and are therefore for non-secret settings only.

This keeps agent and model-provider choices separate. For example, an OpenCode
profile can contain non-secret Bedrock model settings while authentication comes
from the target's isolated AWS connection and target-specific AWS state. Another
profile could launch the same agent with a different provider without changing
the target model.

### Future workspace context and tools

Agent profiles describe **how an agent runs**. They must not become the container
for everything an agent knows about a workspace. A future workspace context model
will describe **what the agent should know**, independently of the selected agent
or model provider. This separation lets a user switch between OpenCode, Claude
Code, or another CLI without duplicating customer knowledge in every profile.

The context model is expected to support these distinct resource types:

- non-secret workspace metadata as typed or string key/value pairs, such as
  service names, owners, criticality, ticket queues, or repository identifiers;
- reference documents such as statements of work, runbooks, work instructions,
  architecture documents, and service inventories;
- workspace instructions that an adapter can materialize into an agent-native
  file such as `AGENTS.md`, `CLAUDE.md`, or another tool-specific equivalent; and
- explicitly enabled tools, including future MCP server declarations.

The exact manifest fields are deferred, but the trust boundaries are not. Context
documents and instruction files must be explicit, inspectable resources. A local
document can be imported as a managed snapshot or reference a file already covered
by a declared workspace directory; a future connector-backed document must retain
its source, synchronization status, and last-updated information. Declaring a
document does not require injecting its complete contents into every prompt. An
adapter can expose a small catalog and let the agent read relevant documents on
demand, avoiding unnecessary context-window use.

Workspace context is read-only to the running agent by default and cannot expand
the target's filesystem or network policy. Metadata and documents may contain
sensitive customer information, so they receive the same private storage and
explicit export rules as other managed workspace resources. Metadata values are
not a secret store.

MCP configuration needs stronger treatment than copying an agent's raw settings.
An MCP server can execute a local command, contact a remote service, request
credentials, and expose powerful tools to the agent. A future normalized MCP
resource must therefore show the command or endpoint and capabilities, run local
servers inside the target sandbox, obey the target network policy, and obtain
credentials through a future broker. Workspace or target policy can then select
which declared servers a profile may use, while an adapter materializes only
those selections into its native configuration format.

Agent-native configuration imported in the first slice may already contain hooks
or MCP declarations. It remains constrained by the process sandbox and network
policy, and the import flow must surface those entries for review. The normalized
workspace tool model is the future portable and policy-aware replacement; it is
not part of the initial agent-profile schema.

### Mutable agent state

Mutable agent data is isolated per workspace, target, and profile:

```text
state/workspaces/<workspace-id>/targets/<target-id>/agents/<profile-id>/
  data/
  cache/
  sessions/
```

An adapter maps only its required mutable locations into that directory. State is
not shared automatically between development and production, even when both use
the same profile. Workspace-level instructions or curated memory may be added
later as explicit, inspectable resources; raw global agent history is not treated
as workspace memory.

### Readiness and launch

Before a target starts, its resolved adapter performs non-mutating readiness
checks. The initial checks are:

- the command resolves to an executable that is reachable inside the sandbox;
- every managed configuration source exists within the workspace resource root;
- every configuration destination is a safe relative path beneath the synthetic
  home; and
- the adapter is available on the current platform.

Adapter-specific checks may be added, but a version command is not assumed to be
safe or universally supported. A failed check prevents only the affected target
from starting and produces an actionable message in the UI.

The Agent pane starts the resolved profile automatically. The other two panes
remain plain target-scoped shells.

## Migration

The new fields are additive while the public API remains experimental. Existing
`opscapsule.dev/v1alpha1` manifests with target-local `agentRuntime` continue to
load. Workspace Studio will preserve that declaration until the user explicitly
creates or selects a managed profile. A later manifest version can remove the
legacy field after all supported workspaces have a deterministic migration path.

## Consequences

- A workspace can configure an agent once and use it across several targets.
- Development and production can select different profiles or keep independent
  mutable state for the same profile.
- Agent configuration works without granting access to the user's real home.
- Bedrock-backed agents can reuse the target's AWS identity rather than maintain a
  second copy of AWS credentials.
- The core remains independent of agent SDKs and model providers, while adapters
  provide the small amount of agent-specific filesystem and readiness knowledge
  needed at the boundary.
- Importing configuration is a security-sensitive operation and needs inspection,
  warnings, and tests for path containment.
- Workspace metadata, reference documents, portable instructions, normalized MCP
  resources, provider secret brokering, shared memory, plugin synchronization,
  and additional agent adapters remain separate increments.
