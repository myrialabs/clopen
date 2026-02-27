/**
 * Component prop types and interfaces
 */

export interface ButtonProps {
	variant?: 'primary' | 'secondary' | 'outline' | 'ghost';
	size?: 'sm' | 'md' | 'lg';
	disabled?: boolean;
	loading?: boolean;
	type?: 'button' | 'submit' | 'reset';
	onclick?: () => void;
}

export interface InputProps {
	value?: string;
	placeholder?: string;
	type?: 'text' | 'password' | 'email' | 'number' | 'search';
	disabled?: boolean;
	error?: string;
	label?: string;
	required?: boolean;
	onchange?: (value: string) => void;
}

export interface TextareaProps {
	value?: string;
	placeholder?: string;
	disabled?: boolean;
	error?: string;
	label?: string;
	required?: boolean;
	rows?: number;
	resize?: 'none' | 'both' | 'horizontal' | 'vertical';
	onchange?: (value: string) => void;
}

export interface SelectOption {
	value: string;
	label: string;
	disabled?: boolean;
}

export interface SelectProps {
	value?: string;
	placeholder?: string;
	disabled?: boolean;
	error?: string;
	label?: string;
	required?: boolean;
	options: SelectOption[];
	onchange?: (value: string) => void;
}

export interface CardProps {
	title?: string;
	subtitle?: string;
	variant?: 'default' | 'outlined' | 'elevated' | 'glass';
	padding?: 'none' | 'sm' | 'md' | 'lg';
	clickable?: boolean;
	onclick?: () => void;
}