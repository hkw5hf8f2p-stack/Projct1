import { readFile } from "node:fs/promises";
import { sha256 } from "../canonical.js";
import { ConfigError } from "../errors.js";
import type { ImagePart } from "../types.js";

/** Байти зображення для відправки; хеш звіряється з заявленим у запиті (запит не може «підмінити» картинку) */
export async function loadImageB64(p: ImagePart): Promise<string> {
  if (p.data_b64) return p.data_b64;
  if (!p.path) throw new ConfigError(`image ${p.sha256.slice(0, 8)} has neither path nor data`);
  const buf = await readFile(p.path);
  if (sha256(buf) !== p.sha256) throw new ConfigError(`image hash mismatch for ${p.path}`);
  return buf.toString("base64");
}
