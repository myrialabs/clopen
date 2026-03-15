/**
 * ERD (Entity Relationship Diagram) Types
 */

export interface ERDColumn {
	name: string;
	type: string;
	isPrimary: boolean;
	isForeign: boolean;
}

export interface ERDTableMeta {
	name: string;
	schema?: string;
	columns: ERDColumn[];
}

export interface ERDRelationship {
	fromTable: string;
	fromColumn: string;
	toTable: string;
	toColumn: string;
	constraintName?: string;
}

export interface ERDMetadata {
	tables: ERDTableMeta[];
	relationships: ERDRelationship[];
}

/** Computed layout node — positions determined by auto-layout */
export interface ERDNode {
	id: string;
	table: ERDTableMeta;
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Computed layout edge */
export interface ERDEdge {
	id: string;
	fromTable: string;
	fromColumn: string;
	toTable: string;
	toColumn: string;
	constraintName?: string;
}
