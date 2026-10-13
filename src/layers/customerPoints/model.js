const LAT_NAMES = ['latitude', 'lat', 'y'];
const LON_NAMES = ['longitude', 'lon', 'lng', 'x'];
const DATE_NAMES = ['date_of_first_contact', 'first_contact_date', 'first_contact', 'contact_date'];
const LABEL_NAMES = ['initials', 'label', 'name'];
const ID_NAMES = ['contact_id', 'customer_id', 'client_id', 'id'];

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length || !text.endsWith('\n')) {
    row.push(field);
    if (row.some((value) => value !== '') || rows.length === 0) rows.push(row);
  }
  return rows;
}

const canon = (name) => String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function indexOfAny(headers, names) {
  const set = new Set(names);
  return headers.findIndex((name) => set.has(name));
}

export function parseFirstContactDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let y, m, d;
  let match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/);
  if (match) [, y, m, d] = match;
  else {
    match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:$|\s)/);
    if (match) {
      [, m, d, y] = match;
      if (String(y).length === 2) y = Number(y) >= 70 ? `19${y}` : `20${y}`;
    }
  }
  if (!match) return null;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { time, iso: date.toISOString().slice(0, 10), label: date.toISOString().slice(0, 10) };
}

function numeric(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function safeLabel(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  const clean = text.replace(/[^\p{L}\p{N}._ -]/gu, '').slice(0, 16).trim();
  return clean || fallback;
}

export function normalizeCustomerCsv(text, { fileName = 'client-side CSV' } = {}) {
  const table = parseCsv(String(text || ''));
  if (table.length < 2) throw new Error('CSV requires a header row and at least one data row');
  const headers = table[0].map(canon);
  const latIndex = indexOfAny(headers, LAT_NAMES);
  const lonIndex = indexOfAny(headers, LON_NAMES);
  const dateIndex = indexOfAny(headers, DATE_NAMES);
  const labelIndex = indexOfAny(headers, LABEL_NAMES);
  const idIndex = indexOfAny(headers, ID_NAMES);
  const sourceIndex = headers.indexOf('first_contact_source');
  if (latIndex < 0 || lonIndex < 0 || dateIndex < 0)
    throw new Error('CSV must include latitude, longitude, and date_of_first_contact columns');

  const seen = new Set();
  const points = [];
  const stats = { totalRows: 0, plotted: 0, unresolved: 0, duplicates: 0, malformed: 0, zeroZero: 0, outOfBounds: 0 };
  for (let rowIndex = 1; rowIndex < table.length; rowIndex += 1) {
    const row = table[rowIndex];
    if (!row.some((value) => String(value || '').trim())) continue;
    stats.totalRows += 1;
    const lat = numeric(row[latIndex]);
    const lon = numeric(row[lonIndex]);
    const parsedDate = parseFirstContactDate(row[dateIndex]);
    if (lat == null || lon == null || !parsedDate) {
      stats.unresolved += 1;
      stats.malformed += 1;
      continue;
    }
    if (lat === 0 && lon === 0) {
      stats.unresolved += 1;
      stats.zeroZero += 1;
      continue;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      stats.unresolved += 1;
      stats.outOfBounds += 1;
      continue;
    }
    // Co-located people are different customers, even on the same date.
    // Use supplied stable identity for dedupe; otherwise only identical rows.
    const suppliedId = idIndex >= 0 ? String(row[idIndex] || '').trim() : '';
    const key = suppliedId ? `id:${suppliedId}` : `row:${JSON.stringify(row)}`;
    if (seen.has(key)) {
      stats.duplicates += 1;
      continue;
    }
    seen.add(key);
    const label = safeLabel(labelIndex >= 0 ? row[labelIndex] : '', `C${points.length + 1}`);
    const dateSource = sourceIndex >= 0 ? String(row[sourceIndex] || '').trim() : 'unspecified';
    points.push({ id: `customer-${points.length + 1}`, lat, lon, date: parsedDate.iso, time: parsedDate.time, label, dateSource });
  }
  points.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  stats.plotted = points.length;
  const dates = points.map((point) => point.time);
  const dateSources = Object.create(null);
  for (const point of points) dateSources[point.dateSource || 'unspecified'] = (dateSources[point.dateSource || 'unspecified'] || 0) + 1;
  return {
    points,
    stats,
    source: { fileName: String(fileName || 'client-side CSV'), dateColumn: 'date_of_first_contact', dateSources, provenance: `CSV-supplied dates, not independently verified first inquiries. Date bases: ${Object.entries(dateSources).map(([name, count]) => `${name}: ${count}`).join(' · ')}. Playback uses UTC calendar dates.` },
    minTime: dates.length ? dates[0] : null,
    maxTime: dates.length ? dates[dates.length - 1] : null,
  };
}

export function visibleCountAt(points, time) {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (points[mid].time <= time) low = mid + 1;
    else high = mid;
  }
  return low;
}
