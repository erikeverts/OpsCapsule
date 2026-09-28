import { describe, expect, it } from "vitest";
import {
  isLinkValue,
  METADATA_ENTRY_LIMIT,
  metadataEntrySchema,
  metadataKind,
  pinnedMetadata,
  resolveMetadata,
  secretLikeMetadataKeys,
} from "../src/shared/metadata.js";
import {
  buildContextCatalog,
  buildContextDocument,
  composeAgentInstructions,
} from "../src/main/workspace-context.js";
import {
  parseWorkspaceManifest,
  validateWorkspaceReferences,
} from "../src/shared/workspace-schema.js";

const entry = (key: string, value: string, extra: object = {}) =>
  metadataEntrySchema.parse({ key, value, ...extra });

describe("metadata entries", () => {
  it("stores only what the user typed", () => {
    expect(entry("project-code", "DIP-1234")).toEqual({
      key: "project-code",
      value: "DIP-1234",
      pinned: false,
    });
  });

  it("derives link-ness from the value rather than asking", () => {
    // Declaring the kind separately was a way to get it wrong: a URL typed
    // into an entry left on "text" was silently unclickable.
    expect(metadataKind(entry("argocd", "https://argocd.example.com"))).toBe("url");
    expect(metadataKind(entry("internal", "http://10.0.0.1:8080"))).toBe("url");
    expect(metadataKind(entry("project-code", "DIP-1234"))).toBe("text");
  });

  it("treats anything that could run locally as text, never a link", () => {
    // Not an error: it is simply not something to open, so it is displayed
    // and never clickable.
    for (const value of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>",
      "vscode://file/etc/passwd",
    ]) {
      expect(isLinkValue(value)).toBe(false);
      expect(metadataKind(entry("link", value))).toBe("text");
    }
  });

  it("still loads a manifest written while kind was a stored field", () => {
    expect(entry("argocd", "http://argo.example.com", { kind: "text" })).toEqual({
      key: "argocd",
      value: "http://argo.example.com",
      pinned: false,
    });
  });

  it("rejects keys that are not simple identifiers", () => {
    expect(() => entry("Project Code", "x")).toThrow();
    expect(() => entry("cost_center", "x")).toThrow();
  });
});

describe("resolution", () => {
  it("lets a target override a workspace entry by key", () => {
    // The point of the override: one key, a different value per environment,
    // rather than argocd-dev and argocd-prod living side by side.
    const resolved = resolveMetadata(
      [entry("argocd", "https://argocd.example.com"), entry("cost-center", "55021")],
      [entry("argocd", "https://argocd-dev.example.com")],
    );
    expect(resolved).toHaveLength(2);
    expect(resolved.find((item) => item.key === "argocd")!.value).toBe(
      "https://argocd-dev.example.com",
    );
    expect(resolved.find((item) => item.key === "cost-center")!.value).toBe("55021");
  });

  it("keeps workspace entries a target says nothing about", () => {
    expect(resolveMetadata([entry("a", "1")], []).map((e) => e.key)).toEqual(["a"]);
  });

  it("selects pinned entries for quick access", () => {
    const entries = [entry("a", "1"), entry("b", "2", { pinned: true })];
    expect(pinnedMetadata(entries).map((e) => e.key)).toEqual(["b"]);
  });
});

describe("guard rails", () => {
  it("names keys that look like secrets", () => {
    expect(
      secretLikeMetadataKeys([
        entry("api-key", "x"),
        entry("db-password", "x"),
        entry("project-code", "x"),
      ]),
    ).toEqual(["api-key", "db-password"]);
  });

  const manifest = (context: object, targetContext: object = { metadata: [], documents: [] }) => ({
    apiVersion: "opscapsule.dev/v1alpha1",
    kind: "Workspace",
    metadata: { id: "atlas", name: "Atlas" },
    context,
    directories: [{ id: "root", name: "Root", path: "/tmp", access: "read-write" }],
    agentProfiles: [
      {
        id: "agent",
        name: "Agent",
        adapter: "command",
        runtime: { command: "sh", args: [] },
        configuration: { files: [] },
        environment: {},
      },
    ],
    defaultAgentProfile: "agent",
    targets: [
      {
        id: "dev",
        name: "Dev",
        environment: "dev",
        risk: "development",
        directories: ["root"],
        defaultDirectory: "root",
        context: targetContext,
        isolation: { mode: "enforced", network: { mode: "public", allowedDomains: [] } },
      },
    ],
  });

  const validate = (input: object) =>
    validateWorkspaceReferences(parseWorkspaceManifest(input));

  it("refuses a manifest holding a secret in metadata", () => {
    expect(() =>
      validate(manifest({ metadata: [{ key: "api-key", value: "sk-live-x" }] })),
    ).toThrow(/must not hold secrets/);
  });

  it("refuses duplicate keys at the same level", () => {
    expect(() =>
      validate(
        manifest({
          metadata: [
            { key: "a", value: "1" },
            { key: "a", value: "2" },
          ],
        }),
      ),
    ).toThrow(/Duplicate metadata key/);
  });

  it("caps what a target actually resolves, not each level separately", () => {
    // Workspace and target are each under the limit, but the target ends up
    // over it, and that is what the agent is given on every turn.
    const workspace = Array.from({ length: 15 }, (_, index) => ({
      key: `w-${index}`,
      value: "x",
    }));
    const target = Array.from({ length: 10 }, (_, index) => ({
      key: `t-${index}`,
      value: "x",
    }));
    expect(() => validate(manifest({ metadata: workspace }, { metadata: target }))).toThrow(
      new RegExp(`more than the limit of ${METADATA_ENTRY_LIMIT}`),
    );
  });

  it("allows overrides that keep the resolved set within the limit", () => {
    const workspace = Array.from({ length: METADATA_ENTRY_LIMIT }, (_, index) => ({
      key: `w-${index}`,
      value: "x",
    }));
    // Overriding does not add an entry, so this stays at the limit.
    expect(() =>
      validate(manifest({ metadata: workspace }, { metadata: [{ key: "w-0", value: "y" }] })),
    ).not.toThrow();
  });
});

describe("capsule context", () => {
  const metadata = [
    entry("project-code", "DIP-1234"),
    entry("argocd", "https://argocd-dev.example.com", {
      label: "ArgoCD",
      pinned: true,
    }),
  ];

  it("inlines values in the catalog so the agent needs no tool call", () => {
    const catalog = buildContextCatalog({ metadata, documents: [] });
    expect(catalog).toContain("project-code");
    expect(catalog).toContain("DIP-1234");
    // Labelled entries keep the key visible: the agent may be asked about
    // either, and the key is what appears in the JSON.
    expect(catalog).toContain("ArgoCD (`argocd`)");
    expect(catalog).toContain("https://argocd-dev.example.com");
    expect(catalog).toContain("$OPSCAPSULE_CONTEXT/context.json");
  });

  it("writes nothing into the catalog when there is no metadata", () => {
    expect(buildContextCatalog({ metadata: [], documents: [] })).toBe("");
  });

  it("keeps the written instructions first and appends the catalog", () => {
    const composed = composeAgentInstructions("# Rules\n\nBe careful.", { metadata, documents: [] });
    expect(composed!.indexOf("Be careful")).toBeLessThan(
      composed!.indexOf("## Workspace context"),
    );
  });

  it("still produces instructions when only metadata exists", () => {
    expect(composeAgentInstructions(undefined, { metadata, documents: [] })).toContain(
      "## Workspace context",
    );
  });

  it("produces nothing when there is neither", () => {
    expect(
      composeAgentInstructions(undefined, { metadata: [], documents: [] }),
    ).toBeUndefined();
  });

  it("writes a versioned document shaped for documents to be added", () => {
    const document = JSON.parse(buildContextDocument({ metadata, documents: [] }));
    expect(document.version).toBe(1);
    expect(document.metadata).toEqual([
      { key: "project-code", value: "DIP-1234", kind: "text" },
      {
        key: "argocd",
        label: "ArgoCD",
        value: "https://argocd-dev.example.com",
        kind: "url",
      },
    ]);
    // pinned is a display choice and has no meaning to the agent.
    expect(JSON.stringify(document)).not.toContain("pinned");
  });
});

describe("opening a pinned link", () => {
  /**
   * Mirrors the main-process handler. The renderer is not trusted to have
   * validated anything, and a manifest is editable and shareable, so the
   * scheme is checked again where the link is actually opened.
   */
  function guard(url: string): string {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("That link is not a valid URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Only http and https links can be opened.");
    }
    return parsed.toString();
  }

  it("opens http and https", () => {
    expect(guard("https://argocd.example.com/applications")).toContain(
      "argocd.example.com",
    );
    expect(guard("http://10.0.0.1:8080")).toContain("10.0.0.1");
  });

  it("refuses schemes that would run something locally", () => {
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "vscode://file/etc/passwd",
    ]) {
      expect(() => guard(url)).toThrow(/http and https/);
    }
  });

  it("refuses something that is not a URL at all", () => {
    expect(() => guard("argocd.example.com")).toThrow(/not a valid URL/);
  });
});

describe("target-specific entries", () => {
  const workspace = [
    entry("project-code", "DIP-1234"),
    entry("argocd", "https://argocd.example.com", { label: "ArgoCD", pinned: true }),
  ];

  it("adds a key that exists only on the target", () => {
    // Not every target entry is an override: a cluster dashboard may exist
    // for one environment and nowhere else.
    const resolved = resolveMetadata(workspace, [
      entry("grafana", "https://grafana-dev.example.com", { pinned: true }),
    ]);
    expect(resolved.map((e) => e.key).sort()).toEqual([
      "argocd",
      "grafana",
      "project-code",
    ]);
  });

  it("replaces the whole entry, so an override carries its own label and pin", () => {
    const resolved = resolveMetadata(workspace, [
      entry("argocd", "https://argocd-dev.example.com"),
    ]);
    const argocd = resolved.find((e) => e.key === "argocd")!;
    expect(argocd.value).toBe("https://argocd-dev.example.com");
    // The editor prefills an override from the workspace entry for exactly
    // this reason: omitting the label here would silently drop it.
    expect(argocd.label).toBeUndefined();
    expect(argocd.pinned).toBe(false);
  });

  it("keeps the label and pin when the override was prefilled", () => {
    const source = workspace.find((e) => e.key === "argocd")!;
    const resolved = resolveMetadata(workspace, [
      { ...source, value: "https://argocd-dev.example.com" },
    ]);
    const argocd = resolved.find((e) => e.key === "argocd")!;
    expect(argocd).toMatchObject({
      label: "ArgoCD",
      pinned: true,
      value: "https://argocd-dev.example.com",
    });
  });

  it("shows the target's value in the sidebar and to the agent", () => {
    const resolved = resolveMetadata(workspace, [
      { ...workspace[1]!, value: "https://argocd-dev.example.com" },
    ]);
    expect(pinnedMetadata(resolved).map((e) => e.value)).toEqual([
      "https://argocd-dev.example.com",
    ]);
    expect(buildContextCatalog({ metadata: resolved, documents: [] })).toContain(
      "https://argocd-dev.example.com",
    );
    expect(buildContextCatalog({ metadata: resolved, documents: [] })).not.toContain(
      "https://argocd.example.com",
    );
  });
});
