'use strict';

const nodemailer = require('nodemailer');
const config = require('../../config');
const logger = require('../../config/logger');
const { BadRequestError } = require('../errors');

function createTransport() {
  const { host, port, user, pass } = config.smtp;
  if (!host || !user || !pass) {
    return null;
  }
  return nodemailer.createTransport({
    host,
    port: port || 587,
    secure: port === 465,
    auth: { user, pass },
  });
}

/**
 * Send an email. Throws BadRequestError if SMTP is not configured.
 */
async function sendEmail({ to, subject, html }) {
  const transport = createTransport();
  if (!transport) {
    throw new BadRequestError(
      'Email service is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS.',
      'EMAIL_NOT_CONFIGURED'
    );
  }

  const from = config.smtp.from || config.smtp.user;
  const info = await transport.sendMail({ from, to, subject, html });
  logger.info({ messageId: info.messageId, to }, 'Email sent');
  return info;
}

module.exports = { sendEmail };
