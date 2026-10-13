/** Minimal CSV reader for our own data files: comma-separated, no quoted fields, header row first. */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  const [header, ...rows] = lines;
  if (!header) return [];
  const cols = header.split(',').map((c) => c.trim());
  return rows.map((line, i) => {
    const cells = line.split(',');
    if (cells.length !== cols.length) {
      throw new Error(`CSV row ${i + 2} has ${cells.length} cells, expected ${cols.length}: ${line}`);
    }
    return Object.fromEntries(cols.map((c, j) => [c, (cells[j] ?? '').trim()]));
  });
}
