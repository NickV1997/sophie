import { fetchWithTimeout } from "../system/net.ts";
import type { Tool } from "./types.ts";

/**
 * Weather via Open-Meteo (keyless, no signup). If no location is given, falls
 * back to the machine's approximate public-IP location so "what's the weather"
 * just works. City-level accuracy.
 */
export const weather: Tool = {
  name: "weather",
  description:
    "Get the current weather and a short forecast for a place. Pass a location " +
    "name (city, 'Paris', 'Austin TX'); if omitted, uses the user's approximate " +
    "location from their public IP. Keyless. Use for 'what's the weather', trip " +
    "planning, or anything weather-dependent.",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string", description: "Place name. Omit to use the user's current location." },
    },
    required: [],
  },
  summarize: (a) => (a.location ? String(a.location) : "here"),
  risk: () => "safe",
  async execute(args, ctx) {
    try {
      const { lat, lon, label } = await resolveCoords(
        typeof args.location === "string" ? args.location.trim() : "",
        ctx.signal,
      );
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
        `&temperature_unit=celsius&wind_speed_unit=kmh&timezone=auto&forecast_days=3`;
      const res = await fetchWithTimeout(url, { signal: ctx.signal, timeoutMs: 12_000 });
      const d: any = await res.json();
      if (!d?.current) return { content: `No weather data for ${label}.`, isError: true };

      const c = d.current;
      const lines = [
        `Weather for ${label}:`,
        `Now: ${describeCode(c.weather_code)}, ${round(c.temperature_2m)}°C (feels ${round(c.apparent_temperature)}°C), ` +
          `humidity ${round(c.relative_humidity_2m)}%, wind ${round(c.wind_speed_10m)} km/h` +
          (c.precipitation ? `, precip ${c.precipitation} mm` : ""),
      ];
      const days: string[] = d.daily?.time ?? [];
      for (let i = 0; i < days.length; i++) {
        const day = i === 0 ? "Today" : new Date(days[i]).toLocaleDateString("en-US", { weekday: "short" });
        lines.push(
          `${day}: ${describeCode(d.daily.weather_code[i])}, ` +
            `${round(d.daily.temperature_2m_min[i])}–${round(d.daily.temperature_2m_max[i])}°C` +
            `, rain ${round(d.daily.precipitation_probability_max[i])}%`,
        );
      }
      return { content: lines.join("\n"), display: `${round(c.temperature_2m)}°C ${label}` };
    } catch (e: any) {
      return { content: `Weather lookup failed: ${e?.message ?? "error"}.`, isError: true };
    }
  },
};

async function resolveCoords(
  location: string,
  signal?: AbortSignal,
): Promise<{ lat: number; lon: number; label: string }> {
  if (location) {
    const queries = geocodeQueries(location);
    let hit: any = null;
    for (const query of queries) {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query.name)}&count=10${query.country ? `&countryCode=${query.country}` : ""}`;
      const res = await fetchWithTimeout(url, { signal, timeoutMs: 12_000 });
      const d: any = await res.json();
      hit = d?.results?.[0];
      if (hit) break;
    }
    if (!hit) throw new Error(`couldn't find "${location}"`);
    const label = [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(", ");
    return { lat: hit.latitude, lon: hit.longitude, label };
  }
  // Fall back to public-IP location.
  const res = await fetchWithTimeout("http://ip-api.com/json/?fields=status,city,regionName,country,lat,lon", { signal, timeoutMs: 10_000 });
  const d: any = await res.json();
  if (d?.status !== "success") throw new Error("could not determine your location");
  const label = [d.city, d.regionName, d.country].filter(Boolean).join(", ") || "your location";
  return { lat: d.lat, lon: d.lon, label };
}

function geocodeQueries(location: string): { name: string; country?: string }[] {
  const raw = location.trim();
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const countryRaw = parts.length > 1 ? parts.at(-1)!.toLowerCase() : "";
  const city = parts[0] || raw;
  const countryMap: Record<string, string> = {
    uk: "GB",
    "u.k.": "GB",
    "united kingdom": "GB",
    england: "GB",
    us: "US",
    usa: "US",
    "u.s.": "US",
    "united states": "US",
  };
  const out: { name: string; country?: string }[] = [];
  if (countryRaw && countryMap[countryRaw]) out.push({ name: city, country: countryMap[countryRaw] });
  out.push({ name: raw });
  if (city !== raw) out.push({ name: city });
  return out;
}

function round(n: unknown): number {
  return Math.round(Number(n) || 0);
}

/** WMO weather code → short description. */
function describeCode(code: number): string {
  const map: Record<number, string> = {
    0: "clear",
    1: "mostly clear",
    2: "partly cloudy",
    3: "overcast",
    45: "fog",
    48: "rime fog",
    51: "light drizzle",
    53: "drizzle",
    55: "heavy drizzle",
    61: "light rain",
    63: "rain",
    65: "heavy rain",
    66: "freezing rain",
    67: "freezing rain",
    71: "light snow",
    73: "snow",
    75: "heavy snow",
    77: "snow grains",
    80: "rain showers",
    81: "rain showers",
    82: "violent rain showers",
    85: "snow showers",
    86: "snow showers",
    95: "thunderstorm",
    96: "thunderstorm w/ hail",
    99: "severe thunderstorm",
  };
  return map[code] ?? `code ${code}`;
}
