'use strict';

const { Parser } = require('json2csv');

/**
 * Converts an array of objects to CSV string.
 * @param {Object[]} data - Array of flat objects
 * @param {string[]} [fields] - Optional field list (auto-detected if omitted)
 * @returns {string} CSV string
 */
function toCSV(data, fields) {
  if (!data || data.length === 0) return '';
  const opts = fields ? { fields } : {};
  const parser = new Parser(opts);
  return parser.parse(data);
}

/**
 * Sends CSV data as a downloadable file response.
 */
function sendCSV(res, data, filename, fields) {
  const csv = toCSV(data, fields);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(csv);
}

module.exports = { toCSV, sendCSV };
