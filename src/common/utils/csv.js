'use strict';

const { Parser } = require('json2csv');

/**
 * Converts an array of objects to CSV string.
 * @param {Object[]} data - Array of flat objects
 * @param {string[]} [fields] - Optional field list (auto-detected if omitted)
 * @returns {string} CSV string
 */
function toCSV(data, fields) {
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0 && (!fields || fields.length === 0)) return '';
  const opts = fields ? { fields } : {};
  const parser = new Parser(opts);

  if (rows.length === 0) {
    return fields.join(',');
  }

  return parser.parse(rows);
}

/**
 * Sends CSV data as a downloadable file response.
 */
function sendCSV(res, data, filename, fields) {
  const csv = toCSV(data, fields);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(`\uFEFF${csv}`);
}

module.exports = { toCSV, sendCSV };
