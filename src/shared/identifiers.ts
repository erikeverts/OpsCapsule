export function identifierFromName(
  name: string,
  fallback = "resource",
): string {
  const identifier = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 80)
    .replace(/-+$/g, "");

  return identifier || fallback;
}

export function uniqueIdentifier(name: string, ids: string[]): string {
  const base = identifierFromName(name);
  if (!ids.includes(base)) {
    return base;
  }
  let suffix = 2;
  while (true) {
    const ending = `-${suffix}`;
    const candidate = `${base.slice(0, 80 - ending.length).replace(/-+$/g, "")}${ending}`;
    if (!ids.includes(candidate)) {
      return candidate;
    }
    suffix += 1;
  }
}
