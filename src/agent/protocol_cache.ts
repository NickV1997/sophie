import type { ToolProtocol } from "../llm/tool-protocol.ts";
import type { ToolSpec } from "../tools/types.ts";

export interface ProtocolArtifacts { toolsBlock: string; grammar?: string; cacheHit: boolean; }
const MAX_ENTRIES = 32;
const cache = new Map<string, Omit<ProtocolArtifacts, "cacheHit">>();

function keyFor(protocol: ToolProtocol, specs: ToolSpec[], allToolNames: string[], grammarEnabled: boolean): string {
  // Tool definitions are immutable after registration. Dynamic MCP tools get a
  // distinct ordered name set, so activation or registration changes the key.
  return `${protocol.id}|${grammarEnabled ? "g" : "n"}|${specs.map((spec) => spec.name).join(",")}|${allToolNames.join(",")}`;
}

export function protocolArtifacts(protocol: ToolProtocol, specs: ToolSpec[], allToolNames: string[], grammarEnabled: boolean): ProtocolArtifacts {
  const key = keyFor(protocol, specs, allToolNames, grammarEnabled);
  const existing = cache.get(key);
  if (existing) {
    // Refresh insertion order so frequently used profiles survive eviction.
    cache.delete(key); cache.set(key, existing);
    return { ...existing, cacheHit: true };
  }
  const created = {
    toolsBlock: protocol.buildToolsBlock(specs),
    ...(grammarEnabled ? { grammar: protocol.grammar(allToolNames) } : {}),
  };
  cache.set(key, created);
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return { ...created, cacheHit: false };
}

export function clearProtocolArtifactCache(): void { cache.clear(); }
export function protocolArtifactCacheSize(): number { return cache.size; }
