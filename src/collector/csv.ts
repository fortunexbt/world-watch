/** Bounded RFC4180 reader, including quoted commas/newlines and escaped quotes. Never evaluates formulae. */
export function csv(text: string): string[][] {
  if (text.length > 2 * 1024 * 1024) throw Error("csv_size_limit");
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === '"') {
      if (field || closed) throw Error("invalid_csv_quote");
      quoted = true;
    } else if (c === "," || c === "\n" || c === "\r") {
      row.push(field);
      field = "";
      closed = false;
      if (c !== ",") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        if (row.some((v) => v !== "")) rows.push(row);
        row = [];
      }
    } else {
      if (closed) throw Error("invalid_csv_quote");
      field += c;
    }
    if (rows.length > 5000 || field.length > 50000 || row.length > 60)
      throw Error("csv_budget");
  }
  if (quoted) throw Error("invalid_csv_quote");
  if (field || row.length) {
    row.push(field);
    if (row.some((v) => v !== "")) rows.push(row);
  }
  return rows;
}
