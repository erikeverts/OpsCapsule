import { isAbsolute, relative, resolve, sep } from "node:path";

export const RENDERER_SCHEME = "opscapsule";
export const RENDERER_URL = `${RENDERER_SCHEME}://app/index.html`;

export function resolveRendererAssetPath(
  requestUrl: string,
  rendererRoot: string,
): string | undefined {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return undefined;
  }

  if (
    url.protocol !== `${RENDERER_SCHEME}:` ||
    url.hostname !== "app" ||
    url.port ||
    url.username ||
    url.password
  ) {
    return undefined;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  if (pathname.includes("\0")) {
    return undefined;
  }

  const root = resolve(rendererRoot);
  const assetPath = resolve(root, `.${pathname}`);
  const relativePath = relative(root, assetPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }

  return assetPath;
}
