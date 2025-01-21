/// <reference lib="deno.unstable" />
import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";

let env: Record<string, string>;

if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
  // Production: Use Deno Deploy env vars
  env = {
    NETATMO_REFRESH_TOKEN: Deno.env.get("NETATMO_REFRESH_TOKEN") ?? "",
    NETATMO_APP_ID: Deno.env.get("NETATMO_APP_ID") ?? "",
    NETATMO_CLIENT_SECRET: Deno.env.get("NETATMO_CLIENT_SECRET") ?? "",
    NETATMO_DEVICE_ID: Deno.env.get("NETATMO_DEVICE_ID") ?? "",
    NETATMO_OUTDOOR_MODULE_ID: Deno.env.get("NETATMO_OUTDOOR_MODULE_ID") ?? "",
    ALLOWED_ORIGINS: Deno.env.get("ALLOWED_ORIGINS") ?? "",
    ENVIRONMENT: Deno.env.get("ENVIRONMENT") ?? "production",
  };
} else {
  // Local development: Use .env file
  env = await load();
}

const ALLOWED_ORIGINS = env["ALLOWED_ORIGINS"]?.split(",").map(origin => origin.trim()) || [];
const ENVIRONMENT = env["ENVIRONMENT"] || "production";

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
  try {
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
      const errorText = await response.text();
      console.error("Token refresh failed:", errorText);

      // If the token is invalid, try using the one from .env
      const envRefreshToken = env["NETATMO_REFRESH_TOKEN"];
      if (envRefreshToken && envRefreshToken !== previousRefreshToken) {
        console.log("Attempting to use refresh token from .env...");
        return refreshToken(envRefreshToken);
      }

      throw new Error(`Token refresh failed: ${response.statusText}\nDetails: ${errorText}`);
    }

    const data = await response.json();
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
    };
  } catch (error) {
    throw error;
  }
}

async function initializeTokens(kv: Deno.Kv): Promise<void> {
  try {
    // First try to get existing token from KV
    const existingToken = await kv.get(["refreshToken"]);
    const envRefreshToken = env["NETATMO_REFRESH_TOKEN"];

    const tokenToUse = existingToken.value as string || envRefreshToken;

    if (!tokenToUse) {
      throw new Error("No refresh token available in KV or environment");
    }

    const tokenResponse = await refreshToken(tokenToUse);
    await kv.set(["accessToken"], tokenResponse.access_token);
    await kv.set(["refreshToken"], tokenResponse.refresh_token);
    console.log("Tokens initialized successfully");
  } catch (error) {
    console.error("Token initialization error:", error);
    throw error;
  }
}

async function getStoredTokens(kv: Deno.Kv): Promise<{ refreshToken: string; accessToken?: string }> {
  const refreshToken = await kv.get(["refreshToken"]);
  const accessToken = await kv.get(["accessToken"]);

  if (!refreshToken.value) {
    throw new Error("No refresh token found. Need to initialize first.");
  }

  return {
    refreshToken: refreshToken.value as string,
    accessToken: accessToken.value as string | undefined
  };
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
    const tokens = await getStoredTokens(kv);

    let accessToken = tokens.accessToken;
    if (!accessToken) {
      const tokenResponse = await refreshToken(tokens.refreshToken);
      accessToken = tokenResponse.access_token;
      await kv.set(["accessToken"], accessToken);
      await kv.set(["refreshToken"], tokenResponse.refresh_token);
    }

    const weatherData = await fetchWeatherData(accessToken);
    await kv.set(["weatherData"], weatherData);
    console.log("Weather data updated:", weatherData);
  } catch (error) {
    console.error("Error updating weather data:", error);
  }
}

// Update your main function:
async function main() {
  // Initialize on startup
  await initializeTokens(kv);

  // Start the update loop
  await updateWeatherData();
  setInterval(updateWeatherData, 30000);

  // Start the server
  Deno.serve(async (req) => {
    const origin = req.headers.get("Origin") || "";
    let allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    if (ENVIRONMENT === "development" && !ALLOWED_ORIGINS.includes(origin)) {
      console.warn(`Allowing origin ${origin} in development mode.`);
      allowedOrigin = origin;
    }

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Methods": "GET",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const weatherData = await kv.get(["weatherData"]);
    return new Response(JSON.stringify(weatherData.value), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "GET",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  });
}

await main();
