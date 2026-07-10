import { fetchWithTimeout } from "../system/net.ts";
import type { Tool } from "./types.ts";

interface IpApi {
  status?: string;
  country?: string;
  regionName?: string;
  city?: string;
  zip?: string;
  lat?: number;
  lon?: number;
  timezone?: string;
  isp?: string;
  query?: string;
}

/**
 * Approximate location from the machine's public IP — no GPS, no permissions,
 * works even with device location services turned off. City-level accuracy;
 * reflects the network's public IP, so a VPN/proxy changes the result.
 */
export const whereAmI: Tool = {
  name: "where_am_i",
  description:
    "Get the user's approximate location (city, region, country, coordinates, " +
    "timezone) from their public IP address. Works without GPS or device " +
    "location services. City-level accuracy; a VPN changes the result. Use for " +
    "location-aware answers (local time, weather, nearby places, 'where am I').",
  parameters: { type: "object", properties: {}, required: [] },
  summarize: () => "public IP",
  risk: () => "safe",
  async execute(_args, ctx) {
    const fields = "status,message,country,regionName,city,zip,lat,lon,timezone,isp,query";
    try {
      const res = await fetchWithTimeout(`http://ip-api.com/json/?fields=${fields}`, { signal: ctx.signal, timeoutMs: 10_000 });
      const d = (await res.json()) as IpApi;
      if (d.status !== "success") throw new Error(`ip-api: ${(d as any).message ?? "failed"}`);
      const place = [d.city, d.regionName, d.country].filter(Boolean).join(", ");
      const lines = [
        `Location: ${place || "unknown"}${d.zip ? ` (${d.zip})` : ""}`,
        `Coordinates: ${d.lat}, ${d.lon}`,
        `Timezone: ${d.timezone}`,
        `Network: ${d.isp ?? "?"} · IP ${d.query ?? "?"}`,
        `Note: approximate, based on public IP (not GPS).`,
      ];
      return { content: lines.join("\n"), display: place || "located" };
    } catch (e: any) {
      return {
        content: `Could not determine location: ${e?.message ?? "lookup failed"}. The device may be offline or the IP lookup service is unreachable.`,
        isError: true,
      };
    }
  },
};
