// Import all seeders
import * as settingsSeeder from './settings_seeder';

// Export all seeders
export const seeders = [
	{
		name: 'settings',
		description: settingsSeeder.description,
		seed: settingsSeeder.seed
	}
];

export default seeders;