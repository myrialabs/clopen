/**
 * Data Generator Types
 * Types for the database data seeding / dummy data generation feature.
 */

/** Faker strategy applied to a column during generation */
export type FakerStrategy =
	| 'firstName'
	| 'lastName'
	| 'fullName'
	| 'email'
	| 'phone'
	| 'address'
	| 'city'
	| 'country'
	| 'zipCode'
	| 'company'
	| 'url'
	| 'username'
	| 'uuid'
	| 'integer'
	| 'float'
	| 'boolean'
	| 'date'
	| 'datetime'
	| 'text'
	| 'sentence'
	| 'words'
	| 'fkReference'
	| 'sequential'
	| 'null';

export const FAKER_STRATEGY_LABELS: Record<FakerStrategy, string> = {
	firstName: 'First Name',
	lastName: 'Last Name',
	fullName: 'Full Name',
	email: 'Email',
	phone: 'Phone Number',
	address: 'Street Address',
	city: 'City',
	country: 'Country',
	zipCode: 'Zip / Postal Code',
	company: 'Company Name',
	url: 'URL',
	username: 'Username',
	uuid: 'UUID',
	integer: 'Integer',
	float: 'Float / Decimal',
	boolean: 'Boolean',
	date: 'Date (YYYY-MM-DD)',
	datetime: 'Datetime',
	text: 'Short Text',
	sentence: 'Sentence',
	words: 'Random Words',
	fkReference: 'FK Reference (auto)',
	sequential: 'Sequential Number',
	null: 'NULL'
};

export const FAKER_STRATEGY_GROUPS: { label: string; strategies: FakerStrategy[] }[] = [
	{
		label: 'Person',
		strategies: ['firstName', 'lastName', 'fullName', 'email', 'phone', 'username']
	},
	{
		label: 'Location',
		strategies: ['address', 'city', 'country', 'zipCode']
	},
	{
		label: 'Business',
		strategies: ['company', 'url']
	},
	{
		label: 'Numbers',
		strategies: ['integer', 'float', 'sequential']
	},
	{
		label: 'Text',
		strategies: ['text', 'words', 'sentence']
	},
	{
		label: 'Other',
		strategies: ['uuid', 'boolean', 'date', 'datetime', 'fkReference', 'null']
	}
];

export interface DataGenColumnOptions {
	min?: number;
	max?: number;
	decimals?: number;
}

export interface DataGenColumnConfig {
	columnName: string;
	strategy: FakerStrategy;
	options?: DataGenColumnOptions;
	/** Auto-populated for FK-constrained columns */
	fkTable?: string;
	fkColumn?: string;
	/** Skip this column during insertion (e.g. auto-increment PKs) */
	skip: boolean;
}

/** Returned by db:datagen:schema — enriched column info with strategy suggestions */
export interface DataGenColumnInfo {
	columnName: string;
	columnType: string;
	nullable: boolean;
	primaryKey: boolean;
	unique: boolean;
	defaultValue?: string | null;
	autoIncrement: boolean;
	suggestedStrategy: FakerStrategy;
	/** FK target table (if the column has a foreign key constraint) */
	fkTable?: string;
	fkColumn?: string;
}

/** Result of a single generation batch */
export interface DataGenBatchResult {
	inserted: number;
	failed: number;
	errors: string[];
	done: boolean;
}
