import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

/** Constant-time per-launch API token validation shared by web runtimes/tests. */
export function authorized(req: Request, url: URL, token: string): boolean {
  const presented = req.headers.get("x-sophie-token") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? "";
  const a = Buffer.from(presented); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
