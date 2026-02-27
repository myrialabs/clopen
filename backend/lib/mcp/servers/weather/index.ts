/**
 * Weather Service - Custom MCP Server
 *
 * Provides weather-related tools using the Open-Meteo API.
 * No API key required.
 */

import { z } from "zod";
import { defineServer } from "../helper";
import { getTemperatureHandler } from "./get-temperature";

export default defineServer({
	name: "weather-service",
	version: "1.0.0",
	tools: {
		"get_temperature": {
			description: "Get current temperature for a location using coordinates. Returns temperature in Fahrenheit.",
			schema: {
				latitude: z.number()
					.min(-90)
					.max(90)
					.describe("Latitude coordinate (-90 to 90)"),
				longitude: z.number()
					.min(-180)
					.max(180)
					.describe("Longitude coordinate (-180 to 180)")
			},
			handler: getTemperatureHandler
		}
	}
});
