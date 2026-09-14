import { fetchText, fetchRange } from './gfs.js';
import { decodeWindGribMessage } from './decode.js';
import { resampleWindGrid } from './grid.js';

/** Keyless ECMWF Open Data root for real-time IFS forecasts. */
export const IFS_BASE = 'https://data.ecmwf.int/forecasts';

/**
 * Select the latest IFS cycle that should be available.
 * @param {number} nowMs - Reference epoch milliseconds.
 * @param {{availabilityLagMs?: number}} [options]
 * @returns {{date: string, hour: number}}
 */
export function selectLatestIfsCycle(
  nowMs,
  { availabilityLagMs = 6 * 3600_000 } = {},
) {
  const shifted = new Date(nowMs - availabilityLagMs);
  return {
    date: shifted.toISOString().slice(0, 10).replaceAll('-', ''),
    hour: Math.floor(shifted.getUTCHours() / 6) * 6,
  };
}

/**
 * Build the IFS GRIB2 and `.index` URLs for one cycle and step.
 * @param {{date: string, hour: number, step?: number}} cycle
 * @returns {{grib: string, index: string}}
 */
export function ifsObjectUrls({ date, hour, step = 0 }) {
  const hh = String(hour).padStart(2, '0');
  const stem = `${IFS_BASE}/${date}/${hh}z/ifs/0p25/oper/${date}${hh}0000-${step}h-oper-fc`;
  // The inventory sits beside the GRIB2 as `<stem>.index`, NOT `<grib2>.index`.
  return { grib: `${stem}.grib2`, index: `${stem}.index` };
}

/**
 * Parse the IFS JSON Lines inventory into `{param, offset, length}` records.
 * Malformed lines are skipped; a payload with no valid lines is rejected.
 * @param {string} text - Raw `.index` body.
 * @returns {Array<{param: string, offset: number, length: number}>}
 */
export function parseIfsIndex(text) {
  const entries = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue; // non-JSON line in the index
    }
    if (
      value?.param &&
      Number.isFinite(value._offset) &&
      Number.isFinite(value._length)
    )
      entries.push({
        param: value.param,
        offset: value._offset,
        length: value._length,
      });
  }
  if (!entries.length) throw new Error('malformed IFS index');
  return entries;
}

/**
 * Byte ranges for the IFS 10 m wind components.
 * @param {Array<{param: string, offset: number, length: number}>} entries
 * @returns {{u: {start: number, end: number}, v: {start: number, end: number}}}
 */
export function ifsWindRanges(entries) {
  const range = (param) => {
    const item = entries.find((entry) => entry.param === param);
    if (!item) throw new Error(`missing ${param}`);
    return { start: item.offset, end: item.offset + item.length - 1 };
  };
  return { u: range('10u'), v: range('10v') };
}

/**
 * Fetch and decode the latest IFS 10 m wind field.
 * @param {{fetchImpl?: Function, now?: Function, targetDx?: number,
 *   decodeImpl?: Function}} [options]
 * @returns {Promise<{cycle: object, level: string, units: string, grid: object}>}
 */
export async function fetchIfsWind({
  fetchImpl = fetch,
  now = () => Date.now(),
  targetDx = 1,
  decodeImpl = decodeWindGribMessage,
} = {}) {
  const cycle = selectLatestIfsCycle(now());
  const urls = ifsObjectUrls(cycle);
  const index = await fetchText({ url: urls.index, fetchImpl });
  const ranges = ifsWindRanges(parseIfsIndex(index.toString()));
  const [uBuffer, vBuffer] = await Promise.all([
    fetchRange({ url: urls.grib, ...ranges.u, fetchImpl }),
    fetchRange({ url: urls.grib, ...ranges.v, fetchImpl }),
  ]);
  const [u, v] = await Promise.all([decodeImpl(uBuffer), decodeImpl(vBuffer)]);
  const grid = resampleWindGrid({
    u: u.values,
    v: v.values,
    ni: u.ni,
    nj: u.nj,
    lo1: u.lo1,
    la1: u.la1,
    di: u.di,
    dj: u.dj,
    dx: targetDx,
    dy: targetDx,
  });
  const runIso = `${cycle.date.slice(0, 4)}-${cycle.date.slice(4, 6)}-${cycle.date.slice(6)}T${String(cycle.hour).padStart(2, '0')}:00:00.000Z`;
  return {
    cycle: { ...cycle, forecastHour: 0, runIso },
    level: '10 m above ground',
    units: 'm/s',
    grid,
  };
}
