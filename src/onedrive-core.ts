/* Pure OneDrive path helpers. Kept out of onedrive.ts so the URL contract is
 * covered by the Node test suite without loading Obsidian's runtime module. */

import { normRel } from "./core";

export const ONEDRIVE_GRAPH = "https://graph.microsoft.com/v1.0";

/** Address an item under the app folder.
 *
 * Graph's path form has two distinct shapes:
 *   metadata: special/approot:/folder/file.md
 *   action:   special/approot:/folder/file.md:/content
 *
 * A trailing colon on the metadata form is not valid. Encode each segment
 * independently so slashes stay structural while #, %, spaces, and Unicode
 * remain safe inside a name. */
export function onedriveItemUrl(path: string, suffix = ""): string {
	const rel = normRel(path);
	const base = `${ONEDRIVE_GRAPH}/me/drive/special/approot`;
	if (!rel) return base + suffix;
	const encoded = rel
		.split("/")
		.map(encodeURIComponent)
		.join("/");
	return `${base}:/${encoded}${suffix ? `:${suffix}` : ""}`;
}

/** Join a percent-encoded Graph itemReference path to a relative vault path. */
export function onedriveReferencePath(base: string, relative: string): string {
	const rel = normRel(relative);
	if (!rel) return base;
	return `${base}/${rel
		.split("/")
		.map(encodeURIComponent)
		.join("/")}`;
}

/** Turn Graph's encoded parentReference.path back into an engine path. */
export function onedriveRelativePath(parentReferencePath: string, approotDisplayPath: string, name: string): string {
	if (!parentReferencePath) return `/${name}`;
	const parent = decodeURIComponent(parentReferencePath);
	const relParent = parent === approotDisplayPath ? "" : parent.startsWith(`${approotDisplayPath}/`) ? parent.slice(approotDisplayPath.length) : "";
	return `${relParent}/${name}`;
}
