'use strict';

const config = require('../../config');
const logger = require('../../config/logger');
const { AppError, BadRequestError } = require('../../common/errors');

const REQUEST_TIMEOUT_MS = 30000;

function sanitizeForLog(value, key = '', depth = 0) {
  if (depth > 5) return '[MaxDepth]';
  if (value === null || value === undefined) return value;

  const normalizedKey = String(key).toLowerCase();
  if (
    normalizedKey.includes('token') ||
    normalizedKey.includes('authorization') ||
    normalizedKey.includes('password') ||
    normalizedKey.includes('secret')
  ) {
    return '[REDACTED]';
  }

  if (typeof value === 'string') {
    if (
      normalizedKey.includes('email') ||
      normalizedKey.includes('mobile') ||
      normalizedKey.includes('phone')
    ) {
      return value.length <= 6 ? '*'.repeat(value.length) : `${value.slice(0, 2)}***${value.slice(-2)}`;
    }
    return value.length > 400 ? `${value.slice(0, 400)}...[truncated]` : value;
  }

  if (typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeForLog(item, key, depth + 1));
  }

  return Object.keys(value).reduce((acc, entryKey) => {
    acc[entryKey] = sanitizeForLog(value[entryKey], entryKey, depth + 1);
    return acc;
  }, {});
}

function paymentLog(event, details = {}, level = 'info') {
  if (!config.payment?.flowLogsEnabled) return;

  const method = typeof logger[level] === 'function' ? level : 'info';
  logger[method]({ event, ...sanitizeForLog(details) }, '[payment-flow]');
}

function getAuthHeader() {
  const token = config.myfatoorah?.token;
  if (!token) {
    throw new AppError('Payment gateway is not configured', 500, 'PAYMENT_GATEWAY_NOT_CONFIGURED');
  }

  return token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}`;
}

function summarizePayload(path, payload = {}) {
  if (path === '/v2/ExecutePayment') {
    return {
      paymentMethodId: payload.PaymentMethodId,
      invoiceValue: payload.InvoiceValue,
      currency: payload.DisplayCurrencyIso,
      hasCustomerEmail: Boolean(payload.CustomerEmail),
      hasCustomerMobile: Boolean(payload.CustomerMobile),
      callbackUrl: payload.CallBackUrl,
      errorUrl: payload.ErrorUrl,
      customerReference: payload.CustomerReference,
      userDefinedField: payload.UserDefinedField,
    };
  }

  if (path === '/v2/InitiatePayment') {
    return {
      invoiceAmount: payload.InvoiceAmount,
      currencyIso: payload.CurrencyIso,
    };
  }

  if (path === '/v2/getPaymentStatus') {
    return {
      keyType: payload.KeyType,
      key: payload.Key,
    };
  }

  return payload;
}

function summarizeResponse(response = {}) {
  const data = response.Data || {};
  const methods = Array.isArray(data.PaymentMethods) ? data.PaymentMethods : [];

  return {
    isSuccess: response.IsSuccess,
    message: response.Message,
    invoiceId: data.InvoiceId,
    paymentId: data.PaymentId,
    invoiceStatus: data.InvoiceStatus,
    invoiceValue: data.InvoiceValue,
    customerReference: data.CustomerReference,
    errorMessage: data.ErrorMessage,
    hasPaymentUrl: Boolean(data.PaymentURL || data.PaymentUrl),
    paymentMethodCount: methods.length,
  };
}

async function parseJsonResponse(response) {
  const body = await response.text();
  if (!body) return null;

  try {
    return JSON.parse(body);
  } catch (err) {
    paymentLog('myfatoorah.response_parse_failed', {
      statusCode: response.status,
      bodySample: body.slice(0, 400),
      err,
    }, 'error');
    throw new AppError('Payment gateway returned an invalid response', 502, 'PAYMENT_PROVIDER_INVALID_RESPONSE');
  }
}

function buildProviderError(response, parsed) {
  const summary = summarizeResponse(parsed || {});
  const isClientError = response.status >= 400 && response.status < 500;
  const error = isClientError
    ? new BadRequestError('Payment gateway rejected the request', 'PAYMENT_PROVIDER_REJECTED')
    : new AppError('Payment gateway request failed', 502, 'PAYMENT_PROVIDER_ERROR');

  error.providerSummary = summary;
  return error;
}

async function request(path, payload) {
  const baseUrl = config.myfatoorah?.baseUrl;
  if (!baseUrl) {
    throw new AppError('Payment gateway is not configured', 500, 'PAYMENT_GATEWAY_NOT_CONFIGURED');
  }

  const url = new URL(path, baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();

  paymentLog('myfatoorah.request_started', {
    path,
    baseUrl: url.origin,
    payload: summarizePayload(path, payload),
  });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: getAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
    });
  } catch (err) {
    paymentLog('myfatoorah.request_failed', { path, err }, 'error');
    throw new AppError('Payment gateway is unavailable', 502, 'PAYMENT_PROVIDER_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }

  const parsed = await parseJsonResponse(response);
  const durationMs = Date.now() - startedAt;
  paymentLog('myfatoorah.response_received', {
    path,
    statusCode: response.status,
    durationMs,
    response: summarizeResponse(parsed || {}),
  }, response.ok ? 'info' : 'warn');

  if (!response.ok) {
    throw buildProviderError(response, parsed);
  }

  if (!parsed) {
    throw new AppError('Payment gateway returned an empty response', 502, 'PAYMENT_PROVIDER_EMPTY_RESPONSE');
  }

  if (parsed.IsSuccess === false) {
    const error = new BadRequestError('Payment gateway rejected the request', 'PAYMENT_PROVIDER_REJECTED');
    error.providerSummary = summarizeResponse(parsed);
    throw error;
  }

  return parsed;
}

async function initiatePayment({ amount, currency }) {
  return request('/v2/InitiatePayment', {
    InvoiceAmount: amount,
    CurrencyIso: currency,
  });
}

async function executePayment(payload) {
  return request('/v2/ExecutePayment', payload);
}

async function getPaymentStatus({ key, keyType }) {
  return request('/v2/getPaymentStatus', {
    Key: key,
    KeyType: keyType,
  });
}

module.exports = {
  initiatePayment,
  executePayment,
  getPaymentStatus,
  summarizeResponse,
};
