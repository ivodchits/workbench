// The weather (step H2): "is it going to rain?", "what's it like in Lisbon this
// weekend?". Open-Meteo, which needs no key: its geocoding finds the place, its
// forecast gives now, the next twelve hours' chance of rain, and the days. The
// place is the one named, or Home from Duck's settings. Runs on `any` host: it
// only needs the internet.

import { z } from "zod";
import { defineTool } from "./registry";

const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST = "https://api.open-meteo.com/v1/forecast";

/** WMO weather codes, as Open-Meteo gives them. */
const CODES: Record<number, string> = {
  0: "clear",
  1: "mostly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "heavy freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "heavy freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "violent showers",
  85: "snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "thunderstorm with heavy hail",
};

export const conditions = (code: number): string => CODES[code] ?? `weather code ${code}`;

interface Place {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  country_code?: string;
  admin1?: string;
}

async function getJson(url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`Open-Meteo answered ${r.status}`);
  return (await r.json()) as Record<string, unknown>;
}

/** The place `query` names: "Paris", or "Paris, Texas" / "Berlin, US" to pick
 *  among those of that name. */
export async function findPlace(query: string, signal: AbortSignal): Promise<Place> {
  const [name, ...rest] = query.split(",").map((s) => s.trim());
  const within = rest.join(" ").toLowerCase();
  const url = `${GEOCODE}?${new URLSearchParams({ name, count: "10", language: "en", format: "json" })}`;
  const found = ((await getJson(url, signal)).results ?? []) as Place[];
  const pick =
    (within && found.find((p) => [p.country, p.country_code, p.admin1].some((s) => s && s.toLowerCase().includes(within)))) || found[0];
  if (!pick) throw new Error(`No place called "${query}" was found.`);
  return pick;
}

export const weather = defineTool({
  name: "weather",
  description:
    "The weather now and the forecast, from Open-Meteo, in °C, km/h and mm: the conditions and temperature now, the chance of rain hour by hour for the next twelve hours, and each day's high, low, conditions and rain. Without `place` it's for the user's home (Home in Duck's settings). For \"is it going to rain?\", \"do I need a jacket?\", \"weather in Lisbon this weekend\".",
  schema: z.object({
    place: z.string().optional().describe('A city, optionally with its region or country: "Paris", "Portland, Oregon".'),
    days: z.number().int().min(1).max(7).optional().describe("Days of forecast, today first; 3 when absent."),
  }),
  tier: "read",
  host: "any",
  timeoutMs: 15_000,
  async run({ place, days }, ctx) {
    const where = place?.trim() || ctx.settings.home;
    if (!where) throw new Error("No place was named and no home is set: ask where, or the user can set Home in Duck's settings (drawer tab).");
    const p = await findPlace(where, ctx.signal);
    const q = new URLSearchParams({
      latitude: String(p.latitude),
      longitude: String(p.longitude),
      current: "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
      hourly: "precipitation_probability,precipitation",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
      forecast_hours: "12",
      forecast_days: String(days ?? 3),
      timezone: "auto",
    });
    const f = await getJson(`${FORECAST}?${q}`, ctx.signal);
    const now = f.current as Record<string, number | string>;
    const hourly = f.hourly as { time: string[]; precipitation_probability: number[]; precipitation: number[] };
    const daily = f.daily as {
      time: string[];
      weather_code: number[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      precipitation_probability_max: number[];
      precipitation_sum: number[];
    };
    return {
      place: [p.name, p.admin1, p.country].filter(Boolean).join(", "),
      localTime: now.time,
      now: {
        conditions: conditions(Number(now.weather_code)),
        temperature: now.temperature_2m,
        feelsLike: now.apparent_temperature,
        windKmh: now.wind_speed_10m,
        precipitationMm: now.precipitation,
      },
      nextHours: hourly.time.map((t, i) => ({
        time: t.slice(11),
        rainChance: hourly.precipitation_probability[i],
        rainMm: hourly.precipitation[i],
      })),
      days: daily.time.map((d, i) => ({
        date: d,
        conditions: conditions(daily.weather_code[i]),
        high: daily.temperature_2m_max[i],
        low: daily.temperature_2m_min[i],
        rainChance: daily.precipitation_probability_max[i],
        rainMm: daily.precipitation_sum[i],
      })),
    };
  },
});
