/// <reference lib="deno.unstable" />
import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";

const env = await load();
const kv = await Deno.openKv();

const NETATMO_API_BASE = "https://api.netatmo.com";
const REFRESH_TOKEN_ENDPOINT = `${NETATMO_API_BASE}/oauth2/token`;
const STATION_DATA_ENDPOINT = `${NETATMO_API_BASE}/api/getstationsdata`;

interface TokenData {
  access_token: string;
  refresh_token: string;
}

interface WeatherData {
  temperature: number;
  pressure: number;
  timestamp: number;
}

interface NetatmoDevice {
  _id: string;
  dashboard_data: {
    Temperature: number;
    Pressure: number;
    [key: string]: number | string;  // for other dashboard data fields
  };
  modules: NetatmoModule[];
}

interface NetatmoModule {
  _id: string;
  dashboard_data?: {
    Temperature: number;
    [key: string]: number | string;
  };
}

interface NetatmoResponse {
  body: {
    devices: NetatmoDevice[];
  };
}

async function refreshToken(previousRefreshToken: string): Promise<TokenData> {
  const formData = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: previousRefreshToken,
    client_id: env["NETATMO_APP_ID"],
    client_secret: env["NETATMO_CLIENT_SECRET"],
  });

  const response = await fetch(REFRESH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formData,
  });

  if (!response.ok) {
    // Add error details
    const errorText = await response.text();
    throw new Error(`Token refresh failed: ${response.statusText}\nDetails: ${errorText}`);
  }

  const data = await response.json();

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
  };
}

async function getOrInitializeRefreshToken(kv: Deno.Kv): Promise<string> {
  // First try to get from KV
  const storedToken = await kv.get(["refreshToken"]);

  if (storedToken.value) {
    return storedToken.value as string;
  }

  // If not in KV, use the initial token from .env
  const initialToken = env["NETATMO_REFRESH_TOKEN"];

  // Store it in KV for future use
  await kv.set(["refreshToken"], initialToken);

  return initialToken;
}

async function fetchWeatherData(accessToken: string): Promise<WeatherData> {
  const params = new URLSearchParams({
    client_id: env["NETATMO_APP_ID"],
    client_secret: env["NETATMO_CLIENT_SECRET"],
    device_id: env["NETATMO_DEVICE_ID"],
    get_favorites: "false",
  });

  const response = await fetch(`${STATION_DATA_ENDPOINT}?${params}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch weather data: ${response.statusText}`);
  }

  const data = await response.json() as NetatmoResponse;
  const station = data.body.devices.find(
    (device: NetatmoDevice) => device._id === env["NETATMO_DEVICE_ID"]
  );
  const outdoorModule = station?.modules.find(
    (module: NetatmoModule) => module._id === env["NETATMO_OUTDOOR_MODULE_ID"]
  );

  return {
    temperature: outdoorModule?.dashboard_data?.Temperature ?? 0,
    pressure: station?.dashboard_data?.Pressure ?? 0,
    timestamp: Date.now(),
  };
}

async function updateWeatherData() {
  try {
    const tokenData = await kv.get<TokenData>(["tokens"]);
    let currentTokens = tokenData.value;

    if (!currentTokens) {
      // Initial tokens must be set manually
      const initialRefreshToken = await getOrInitializeRefreshToken(kv);
      currentTokens = await refreshToken(initialRefreshToken);
      await kv.set(["tokens"], currentTokens);
    }

    // Gets new tokens using the current refresh token
    const newTokens = await refreshToken(currentTokens.refresh_token);
    // Saves the new tokens in KV store
    await kv.set(["tokens"], newTokens);

    // Fetch weather data
    const weatherData = await fetchWeatherData(newTokens.access_token);
    await kv.set(["weather"], weatherData);

    console.log("Weather data updated:", weatherData);
  } catch (error) {
    console.error("Error updating weather data:", error);
  }
}

// Initial update
await updateWeatherData();

// Schedule updates every 30 seconds
setInterval(updateWeatherData, 30000);

// Simple HTTP server to check the latest data
Deno.serve(async () => {
  const weatherData = await kv.get(["weather"]);
  return new Response(JSON.stringify(weatherData.value), {
    headers: { "Content-Type": "application/json" },
  });
});
