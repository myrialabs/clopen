/**
 * Get Temperature Handler
 */

export async function getTemperatureHandler(args: { latitude: number; longitude: number }) {
	try {
		// Call Open-Meteo API (no API key required)
		const url = `https://api.open-meteo.com/v1/forecast?latitude=${args.latitude}&longitude=${args.longitude}&current=temperature_2m&temperature_unit=fahrenheit`;

		const response = await fetch(url);

		if (!response.ok) {
			return {
				content: [{
					type: "text" as const,
					text: `Failed to fetch weather data: ${response.status} ${response.statusText}`
				}],
				isError: true
			};
		}

		const data = await response.json();

		// Check if temperature data is available
		if (!data.current || data.current.temperature_2m === undefined) {
			return {
				content: [{
					type: "text" as const,
					text: "Temperature data not available for this location."
				}],
				isError: true
			};
		}

		const temperature = data.current.temperature_2m;
		const unit = data.current_units?.temperature_2m || "°F";

		return {
			content: [{
				type: "text" as const,
				text: `Temperature: ${temperature}${unit}`
			}]
		};

	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';

		return {
			content: [{
				type: "text" as const,
				text: `Error fetching temperature: ${errorMessage}`
			}],
			isError: true
		};
	}
}
