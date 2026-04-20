'use strict';

const { toCSV } = require('./csv');

function normalizeFields(rows, fields) {
  if (fields && fields.length > 0) {
    return fields;
  }

  if (!rows || rows.length === 0) {
    return [];
  }

  return Object.keys(rows[0]);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapePdf(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function formatCellValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value);
}

function buildExcelWorkbook(rows, fields, worksheetName = 'Report') {
  const headers = fields.map((field) => `<Cell><Data ss:Type="String">${escapeXml(field)}</Data></Cell>`);
  const bodyRows = rows.map((row) => {
    const cells = fields.map((field) => (
      `<Cell><Data ss:Type="String">${escapeXml(formatCellValue(row[field]))}</Data></Cell>`
    ));
    return `<Row>${cells.join('')}</Row>`;
  });

  return [
    '<?xml version="1.0"?>',
    '<?mso-application progid="Excel.Sheet"?>',
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"',
    ' xmlns:o="urn:schemas-microsoft-com:office:office"',
    ' xmlns:x="urn:schemas-microsoft-com:office:excel"',
    ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
    `  <Worksheet ss:Name="${escapeXml(worksheetName)}">`,
    '    <Table>',
    `      <Row>${headers.join('')}</Row>`,
    ...bodyRows.map((row) => `      ${row}`),
    '    </Table>',
    '  </Worksheet>',
    '</Workbook>',
  ].join('\n');
}

function buildPdfBuffer(title, rows, fields) {
  const lines = [];
  if (title) {
    lines.push(title);
    lines.push('');
  }

  if (fields.length > 0) {
    lines.push(fields.join(' | '));
    lines.push('-'.repeat(Math.min(120, fields.join(' | ').length || 1)));
  }

  for (const row of rows) {
    lines.push(fields.map((field) => formatCellValue(row[field])).join(' | '));
  }

  if (lines.length === 0) {
    lines.push(title || 'Report');
    lines.push('');
    lines.push('No data available.');
  }

  const pageSize = 42;
  const pages = [];
  for (let index = 0; index < lines.length; index += pageSize) {
    pages.push(lines.slice(index, index + pageSize));
  }

  const objects = [];
  const fontObjectId = 3;
  const pageRefs = [];

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[fontObjectId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let nextObjectId = 4;
  for (const pageLines of pages) {
    const contentObjectId = nextObjectId++;
    const pageObjectId = nextObjectId++;
    const escapedLines = pageLines.map((line) => `(${escapePdf(line.slice(0, 120))}) Tj`);
    const content = [
      'BT',
      '/F1 10 Tf',
      '14 TL',
      '50 760 Td',
      escapedLines.length > 0 ? escapedLines[0] : '( ) Tj',
      ...escapedLines.slice(1).map((line) => `T* ${line}`),
      'ET',
    ].join('\n');

    objects[contentObjectId] = [
      `<< /Length ${Buffer.byteLength(content, 'utf8')} >>`,
      'stream',
      content,
      'endstream',
    ].join('\n');

    objects[pageObjectId] = [
      '<< /Type /Page',
      ' /Parent 2 0 R',
      ' /MediaBox [0 0 612 792]',
      ` /Resources << /Font << /F1 ${fontObjectId} 0 R >> >>`,
      ` /Contents ${contentObjectId} 0 R`,
      '>>',
    ].join('');

    pageRefs.push(`${pageObjectId} 0 R`);
  }

  objects[2] = `<< /Type /Pages /Count ${pageRefs.length} /Kids [${pageRefs.join(' ')}] >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];

  for (let objectId = 1; objectId < objects.length; objectId++) {
    offsets[objectId] = Buffer.byteLength(pdf, 'utf8');
    pdf += `${objectId} 0 obj\n${objects[objectId]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length}\n`;
  pdf += '0000000000 65535 f \n';

  for (let objectId = 1; objectId < objects.length; objectId++) {
    pdf += `${String(offsets[objectId]).padStart(10, '0')} 00000 n \n`;
  }

  pdf += [
    'trailer',
    `<< /Size ${objects.length} /Root 1 0 R >>`,
    'startxref',
    `${xrefOffset}`,
    '%%EOF',
  ].join('\n');

  return Buffer.from(pdf, 'utf8');
}

function sendTabularExport(res, {
  rows,
  fields,
  filenameBase,
  format = 'csv',
  title,
  worksheetName,
}) {
  const normalizedFields = normalizeFields(rows, fields);

  if (format === 'excel') {
    const workbook = buildExcelWorkbook(rows, normalizedFields, worksheetName || title || 'Report');
    res.setHeader('Content-Type', 'application/vnd.ms-excel');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.xls"`);
    return res.send(workbook);
  }

  if (format === 'pdf') {
    const pdf = buildPdfBuffer(title || filenameBase, rows, normalizedFields);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.pdf"`);
    return res.send(pdf);
  }

  const csv = toCSV(rows, normalizedFields);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
  return res.send(csv);
}

module.exports = {
  sendTabularExport,
};
