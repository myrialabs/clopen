import { describe, it, expect } from 'bun:test';
import {
	quoteMssql,
	renderColumn,
	renderCreateTable
} from './sql-builders';

describe('sql-builders mssql support', () => {
	describe('quoteMssql', () => {
		it('should quote simple identifier', () => {
			expect(quoteMssql('users')).toBe('[users]');
		});

		it('should throw error for invalid character [', () => {
			expect(() => quoteMssql('user[s')).toThrow();
		});

		it('should throw error for invalid character ]', () => {
			expect(() => quoteMssql('user]s')).toThrow();
		});

		it('should throw error for empty identifier', () => {
			expect(() => quoteMssql('')).toThrow();
		});
	});

	describe('renderColumn', () => {
		it('should render standard identity column', () => {
			const col = {
				name: 'id',
				type: 'INT',
				nullable: false,
				autoIncrement: true,
				primary: true
			};
			const result = renderColumn({ quote: quoteMssql, column: col, driver: 'mssql' });
			expect(result).toBe('[id] INT NOT NULL IDENTITY(1,1) PRIMARY KEY');
		});

		it('should render standard nullable column with default value', () => {
			const col = {
				name: 'name',
				type: 'VARCHAR(255)',
				nullable: true,
				default: "'anonymous'"
			};
			const result = renderColumn({ quote: quoteMssql, column: col, driver: 'mssql' });
			expect(result).toBe("[name] VARCHAR(255) DEFAULT 'anonymous'");
		});
	});

	describe('renderCreateTable', () => {
		it('should render correct DDL for simple table', () => {
			const definition = {
				name: 'products',
				columns: [
					{ name: 'id', type: 'INT', nullable: false, autoIncrement: true },
					{ name: 'title', type: 'NVARCHAR(100)', nullable: true }
				],
				primaryKey: ['id']
			};
			const result = renderCreateTable({
				quote: quoteMssql,
				definition,
				driver: 'mssql'
			});
			expect(result).toBe('CREATE TABLE [products] ([id] INT NOT NULL IDENTITY(1,1), [title] NVARCHAR(100), PRIMARY KEY ([id]))');
		});
	});
});
