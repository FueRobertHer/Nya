// A small RFC 4180 reader for the tests, to show what a spreadsheet gets back
// from the CSV files the download of my data writes (lib/csv.ts). A leading
// byte order mark is dropped, as spreadsheets drop it.

export function parseCsv(text: string): string[][] {
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else field += c;
  }
  if (field !== '' || row.length > 0) throw new Error('The last record does not end in CRLF');
  return rows;
}
