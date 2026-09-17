# ADR 0001: Electron and TypeScript architecture spike

- Status: Experimental
- Date: 2026-09-17

## Context

Operations work often mixes several customer or project contexts on one machine. A
global `kubectl` context, inherited AWS variables, and long-running agent sessions
make it easy for one terminal to affect another.

OpsCapsule also needs to support different agent tools and model providers without
making any one SDK part of its core architecture.

## Decision

The spike uses Electron, React, TypeScript, xterm.js, and node-pty.

The Electron main process owns operating-system access and PTYs. The renderer is
sandboxed and can only use a narrow preload API with validated IPC inputs. Each
workspace receives its own runtime directory, kubeconfig file, and copied process
environment.

Agent processes use a runtime-adapter interface. The first adapter launches an
arbitrary command and arguments inside a capsule. It does not know about agent
protocols, LLM providers, authentication, prompts, or memory formats.

## Consequences

- Interactive CLI agents can be integrated without embedding their SDKs.
- AWS and Kubernetes isolation is explicit and testable.
- The product can evolve toward additional adapters such as containers, SSH, MCP,
  or native agent protocols without changing terminal orchestration.
- Electron and node-pty add packaging and native-module maintenance work.
- A separate security review is required before the tool can execute real
  production credentials or untrusted workspace definitions.

## Questions for the next increment

- Should stronger isolation use per-capsule containers or OS-native sandboxes?
- What is the portable workspace configuration format?
- Which information belongs in global, organization, workspace, and task memory?
- How should secrets be referenced without storing them in project files?
- Which adapter capabilities should be discoverable rather than assumed?

