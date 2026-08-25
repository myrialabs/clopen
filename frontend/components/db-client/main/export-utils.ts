/**
 * Shared tabular-export helpers for the DB client (CSV / TSV / XLSX +
 * download). Kept in one place so the data grid and the result panel don't
 * each carry their own copy.
 */

function escapeDelimited(val: unknown, delimiter: ',' | '\t'): string {
	if (val === null || val === undefined) return '';
	const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
	if (str.includes(delimiter) || str.includes('"') || str.includes('\n') || str.includes('\r')) {
		return `"${str.replace(/"/g, '""')}"`;
	}
	return str;
}

export function toCsv(columns: string[], rows: unknown[][]): string {
	const header = columns.map((c) => escapeDelimited(c, ',')).join(',');
	const body = rows.map((row) => row.map((v) => escapeDelimited(v, ',')).join(',')).join('\n');
	return `${header}\n${body}`;
}

export function toTsv(columns: string[], rows: unknown[][]): string {
	const header = columns.map((c) => escapeDelimited(c, '\t')).join('\t');
	const body = rows.map((row) => row.map((v) => escapeDelimited(v, '\t')).join('\t')).join('\n');
	return `${header}\n${body}`;
}

function escapeXml(unsafe: string): string {
	return unsafe.replace(/[<>&'"]/g, (c) => {
		switch (c) {
			case '<': return '&lt;';
			case '>': return '&gt;';
			case '&': return '&amp;';
			case '\'': return '&apos;';
			case '"': return '&quot;';
			default: return c;
		}
	});
}

function excelCellRef(colIdx: number, rowNum: number): string {
	let temp = colIdx;
	let letter = '';
	while (temp >= 0) {
		letter = String.fromCharCode((temp % 26) + 65) + letter;
		temp = Math.floor(temp / 26) - 1;
	}
	return letter + rowNum;
}

/** Build a minimal (inline-string) XLSX workbook from tabular data. */
export async function buildXlsx(columns: string[], rows: unknown[][]): Promise<Uint8Array> {
	const { zip } = await import('@myrialabs/zipkit');

	let sheetData = '<row r="1">';
	for (let cIdx = 0; cIdx < columns.length; cIdx++) {
		sheetData += `<c r="${excelCellRef(cIdx, 1)}" t="inlineStr"><is><t>${escapeXml(columns[cIdx])}</t></is></c>`;
	}
	sheetData += '</row>';

	for (let rIdx = 0; rIdx < rows.length; rIdx++) {
		const rowNum = rIdx + 2;
		sheetData += `<row r="${rowNum}">`;
		const row = rows[rIdx];
		for (let cIdx = 0; cIdx < columns.length; cIdx++) {
			const val = row[cIdx];
			if (val === null || val === undefined) continue;
			const cellRef = excelCellRef(cIdx, rowNum);
			if (typeof val === 'number') {
				sheetData += `<c r="${cellRef}"><v>${String(val)}</v></c>`;
			} else {
				const strVal = escapeXml(typeof val === 'object' ? JSON.stringify(val) : String(val));
				sheetData += `<c r="${cellRef}" t="inlineStr"><is><t>${strVal}</t></is></c>`;
			}
		}
		sheetData += '</row>';
	}

	const sheet1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${sheetData}</sheetData>
</worksheet>`;

	const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheets>
<sheet name="Sheet1" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
</sheets>
</workbook>`;

	const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

	const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

	const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

	const encoder = new TextEncoder();
	return zip([
		{ name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
		{ name: '_rels/.rels', data: encoder.encode(rels) },
		{ name: 'xl/workbook.xml', data: encoder.encode(workbookXml) },
		{ name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(workbookRels) },
		{ name: 'xl/worksheets/sheet1.xml', data: encoder.encode(sheet1Xml) }
	]);
}

/** Trigger a browser download for text or binary content. */
export function downloadFile(content: string | Uint8Array, filename: string, mime: string): void {
	// Copy binary content into a fresh ArrayBuffer-backed view so it satisfies
	// the DOM `BlobPart` type (which excludes SharedArrayBuffer-backed views).
	const part: BlobPart = typeof content === 'string' ? content : new Uint8Array(content);
	const blob = new Blob([part], { type: mime });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}
