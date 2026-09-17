# Runtime adapter spike

## Hypothesis

A desktop application can keep concurrent operations contexts separate while
remaining independent of agent frameworks and model providers.

## Acceptance criteria

- Two demo workspaces can stay active at the same time.
- Every workspace has three independent pseudo-terminals.
- Every pseudo-terminal in a workspace receives the same capsule-specific AWS and
  Kubernetes environment.
- Different workspaces receive different kubeconfig paths and files.
- The agent pane is launched through a generic runtime adapter.
- The renderer has no direct Node.js or shell access.
- Tests demonstrate kubeconfig and environment isolation.

## Deliberate limitations

- Demo kubeconfigs point to `.invalid` endpoints and contain no credentials.
- Workspace definitions are currently compiled-in examples.
- The agent pane starts the user's shell until a workspace selects an agent command.
- Memory, ticket integrations, credential brokers, packaging, auto-update, and
  production hardening are outside this spike.

## Suggested manual checks

Launch both capsules and run the following in terminals from each:

```sh
printf '%s\n' "$OPSCAPSULE_WORKSPACE" "$AWS_PROFILE" "$KUBECONFIG"
kubectl config current-context
```

Changing the kubeconfig in one capsule must not change the output in the other.

