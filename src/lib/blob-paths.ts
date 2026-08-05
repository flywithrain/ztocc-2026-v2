const SOURCE_PREFIX = "imports/source/";
const MANIFEST_PREFIX = "imports/manifests/";
const BATCH_PREFIX = "imports/batches/";

export const IMPORT_BLOB_PREFIXES = {
  source: SOURCE_PREFIX,
  manifest: MANIFEST_PREFIX,
  batch: BATCH_PREFIX,
} as const;

export function buildSourceBlobPath(fileName: string) {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/\.{2,}/g, "_").slice(-180) || "import.bin";
  return `${SOURCE_PREFIX}${crypto.randomUUID()}/${safeName}`;
}

export function buildManifestBlobPath() {
  return `${MANIFEST_PREFIX}${crypto.randomUUID()}.json`;
}
