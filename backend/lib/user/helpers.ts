/**
 * User domain helper functions
 */

// List of friendly animal names for anonymous users
export const ANIMAL_NAMES = [
	'Penguin', 'Koala', 'Panda', 'Tiger', 'Lion', 'Eagle', 'Dolphin', 'Elephant',
	'Giraffe', 'Zebra', 'Kangaroo', 'Octopus', 'Butterfly', 'Fox', 'Wolf', 'Bear',
	'Rabbit', 'Deer', 'Owl', 'Hawk', 'Falcon', 'Parrot', 'Peacock', 'Swan',
	'Flamingo', 'Pelican', 'Seal', 'Walrus', 'Otter', 'Beaver', 'Raccoon', 'Squirrel',
	'Hedgehog', 'Hamster', 'Gecko', 'Chameleon', 'Turtle', 'Frog', 'Salamander', 'Newt',
	'Shark', 'Whale', 'Stingray', 'Jellyfish', 'Starfish', 'Crab', 'Lobster', 'Shrimp',
	'Ant', 'Bee', 'Ladybug', 'Dragonfly', 'Cricket', 'Grasshopper', 'Beetle', 'Moth',
	'Cheetah', 'Jaguar', 'Leopard', 'Lynx', 'Cougar', 'Panther', 'Ocelot', 'Serval',
	'Monkey', 'Gorilla', 'Chimpanzee', 'Orangutan', 'Lemur', 'Sloth', 'Armadillo', 'Pangolin',
	'Platypus', 'Echidna', 'Wombat', 'Tasmanian', 'Quokka', 'Wallaby', 'Possum', 'Bandicoot',
	'Meerkat', 'Mongoose', 'Ferret', 'Weasel', 'Badger', 'Skunk', 'Porcupine', 'Chinchilla',
	'Capybara', 'Alpaca', 'Llama', 'Vicuna', 'Camel', 'Yak', 'Bison', 'Buffalo',
	'Moose', 'Elk', 'Reindeer', 'Antelope', 'Gazelle', 'Impala', 'Wildebeest', 'Okapi'
];

// Colors for additional uniqueness
export const COLORS = [
	'Red', 'Blue', 'Green', 'Yellow', 'Purple', 'Orange', 'Pink', 'Brown',
	'Gray', 'Black', 'White', 'Silver', 'Gold', 'Cyan', 'Magenta', 'Lime',
	'Indigo', 'Violet', 'Turquoise', 'Coral', 'Salmon', 'Crimson', 'Navy', 'Teal'
];

export interface AnonymousUser {
	id: string;
	name: string;
	color: string;
	avatar: string;
	createdAt: string;
}

/**
 * Generate a consistent color from a string
 */
export function generateColorFromString(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = str.charCodeAt(i) + ((hash << 5) - hash);
	}

	const hue = hash % 360;
	return `hsl(${hue}, 70%, 50%)`;
}

/**
 * Get initials from name
 */
export function getInitials(name: string): string {
	const trimmed = name.trim();

	// Try to get initials from first two words
	const words = trimmed.split(' ');
	if (words.length >= 2) {
		return (words[0][0] + words[1][0]).toUpperCase();
	}

	// Fallback to first 2 characters
	return trimmed.substring(0, 2).toUpperCase();
}

/**
 * Generate a unique anonymous user identity
 */
export function generateAnonymousUser(): AnonymousUser {
	const randomAnimal = ANIMAL_NAMES[Math.floor(Math.random() * ANIMAL_NAMES.length)];
	const randomColor = COLORS[Math.floor(Math.random() * COLORS.length)];
	const randomNumber = Math.floor(Math.random() * 1000);

	const name = `${randomColor} ${randomAnimal} ${randomNumber}`;
	const id = `user-${crypto.randomUUID()}`; // Server-side crypto API

	// Generate a color for the avatar based on the name
	const avatarColor = generateColorFromString(name);

	return {
		id,
		name,
		color: avatarColor,
		avatar: getInitials(randomAnimal),
		createdAt: new Date().toISOString()
	};
}
