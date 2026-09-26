import { describe, expect, it } from "vitest";
import {
  METADATA_ENTRY_LIMIT,
  metadataEntrySchema,
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
  it("defaults to a plain text entry that is not pinned", () => {
    expect(entry("project-code", "DIP-1234")).toEqual({
      key: "project-code",
      value: "DIP-1234",
      kind: "text",
      pinned: false,
    });
  });

  it("rejects a url entry whose value is not a url", () => {
    expect(() =>
      entry("argocd", "argocd.example.com", { kind: "url" }),
    ).toThrow(/not a URL/);
  });

  it("rejects a url that could run something locally", () => {
    // A manifest is shareable and pinned entries are opened by clicking, so
    // anything but http or https turns a pin into local code execution.
    for (const value of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>",
    ]) {
      expect(() => entry("link", value, { kind: "url" })).toThrow(
        /http or https/,
      );
    }
  });

  it("accepts http and https", () => {
    expect(entry("argocd", "https://argocd.example.com", { kind: "url" }).kind).toBe("url");
    expect(entry("internal", "http://10.0.0.1:8080", { kind: "url" }).value).toBe(
      "http://10.0.0.1:8080",
    );
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
      [entry("argocd", "https://argocd.example.com", { kind: "url" }), entry("cost-center", "55021")],
      [entry("argocd", "https://argocd-dev.example.com", { kind: "url" })],
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

  const manifest = (context: object, targetContext: object = { metadata: [] }) => ({
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
      kind: "url",
      label: "ArgoCD",
      pinned: true,
    }),
  ];

  it("inlines values in the catalog so the agent needs no tool call", () => {
    const catalog = buildContextCatalog({ metadata });
    expect(catalog).toContain("project-code");
    expect(catalog).toContain("DIP-1234");
    // Labelled entries keep the key visible: the agent may be asked about
    // either, and the key is what appears in the JSON.
    expect(catalog).toContain("ArgoCD (`argocd`)");
    expect(catalog).toContain("https://argocd-dev.example.com");
    expect(catalog).toContain("$OPSCAPSULE_CONTEXT/context.json");
  });

  it("writes nothing into the catalog when there is no metadata", () => {
    expect(buildContextCatalog({ metadata: [] })).toBe("");
  });

  it("keeps the written instructions first and appends the catalog", () => {
    const composed = composeAgentInstructions("# Rules\n\nBe careful.", {
      metadata,
    });
    expect(composed!.indexOf("Be careful")).toBeLessThan(
      composed!.indexOf("## Workspace context"),
    );
  });

  it("still produces instructions when only metadata exists", () => {
    expect(composeAgentInstructions(undefined, { metadata })).toContain(
      "## Workspace context",
    );
  });

  it("produces nothing when there is neither", () => {
    expect(
      composeAgentInstructions(undefined, { metadata: [] }),
    ).toBeUndefined();
  });

  it("writes a versioned document shaped for documents to be added", () => {
    const document = JSON.parse(buildContextDocument({ metadata }));
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
