/**
 * Theme and theming types
 */

export interface Theme {
	name: string;
	primary: string;
	secondary: string;
	background: string;
	text: string;
	mode: 'light' | 'dark';
}