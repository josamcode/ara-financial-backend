'use strict';

function formatAmount(amount, currency) {
  const num = Number(amount ?? 0);
  return `${num.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency || 'EGP'}`;
}

function formatDate(date) {
  if (!date) return '';
  return new Date(date).toLocaleDateString('ar-EG');
}

/**
 * Builds the invoice email subject and HTML body.
 * v1 intentionally sends invoice details only: no attachment and no public/protected invoice link.
 */
function buildInvoiceEmail({ invoice, companyName }) {
  const subject = `فاتورة رقم ${invoice.invoiceNumber} من ${companyName}`;

  const dueDateLine = invoice.dueDate
    ? `<tr><td style="padding:4px 0;color:#555;">تاريخ الاستحقاق:</td><td style="padding:4px 0;font-weight:600;">${formatDate(invoice.dueDate)}</td></tr>`
    : '';

  const remainingLine = invoice.remainingAmount != null
    ? `<tr><td style="padding:4px 0;color:#555;">المبلغ المتبقي:</td><td style="padding:4px 0;font-weight:600;">${formatAmount(invoice.remainingAmount, invoice.currency)}</td></tr>`
    : '';

  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;direction:rtl;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;max-width:560px;width:100%;">
        <tr><td style="background:#1d4ed8;padding:20px 32px;">
          <p style="margin:0;color:#fff;font-size:18px;font-weight:700;">${companyName}</p>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 8px;font-size:16px;color:#111;">مرحباً،</p>
          <p style="margin:0 0 24px;color:#444;font-size:14px;line-height:1.6;">
            يرجى الاطلاع على تفاصيل الفاتورة رقم <strong>${invoice.invoiceNumber}</strong> المرفقة أدناه.
          </p>
          <table cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;margin-bottom:8px;">
            <tr>
              <td style="padding:4px 0;color:#555;">رقم الفاتورة:</td>
              <td style="padding:4px 0;font-weight:600;">${invoice.invoiceNumber}</td>
            </tr>
            <tr>
              <td style="padding:4px 0;color:#555;">الإجمالي:</td>
              <td style="padding:4px 0;font-weight:600;">${formatAmount(invoice.total, invoice.currency)}</td>
            </tr>
            ${remainingLine}
            ${dueDateLine}
          </table>
          <p style="margin:32px 0 0;color:#999;font-size:12px;">هذه الرسالة أُرسلت تلقائياً من نظام ARA Financial.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html };
}

module.exports = { buildInvoiceEmail };
