'use strict';

const mongoose = require('mongoose');
const { PaymentAttempt } = require('./payment.model');
const myfatoorahClient = require('./myfatoorah.client');
const auditService = require('../audit/audit.service');
const config = require('../../config');
const logger = require('../../config/logger');
const { AppError } = require('../../common/errors');

const PROVIDER = 'myfatoorah';
const RESOURCE_TYPE = 'PaymentAttempt';

function normalizeBaseUrl(value) {
  return value ? String(value).replace(/\/+$/, '') : null;
}

function toDecimal128(value) {
  return mongoose.Types.Decimal128.fromString(String(value));
}

function toNumber(value) {
  const parsed = Number(value?.toString?.() ?? value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asString(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function truncate(value, maxLength = 500) {
  if (!value) return null;
  const text = String(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function parseProviderAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  const normalized = value.replace(/,/g, '');
  const match = normalized.match(/-?\d+(\.\d+)?/);
  if (!match) return null;

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapInvoiceStatus(invoiceStatus) {
  const normalized = String(invoiceStatus || '').toLowerCase();
  if (normalized === 'paid' || normalized.includes('paid')) return 'paid';
  if (normalized.includes('cancel')) return 'cancelled';
  if (normalized.includes('expir')) return 'expired';
  if (normalized.includes('pending') || normalized.includes('process')) return 'pending';
  if (normalized.includes('fail') || normalized.includes('error') || normalized.includes('declin')) {
    return 'failed';
  }
  return 'failed';
}

function pickPaymentMethod(methods = []) {
  if (!Array.isArray(methods) || methods.length === 0) return null;

  const preferredKeywords = ['visa', 'master', 'credit', 'mada', 'apple', 'stc'];
  const keywordMatch = methods.find((method) => {
    const label = `${method.PaymentMethodEn || ''} ${method.PaymentMethodAr || ''}`.toLowerCase();
    return preferredKeywords.some((keyword) => label.includes(keyword));
  });

  if (keywordMatch && keywordMatch.IsDirectPayment === false) return keywordMatch;

  const nonDirect = methods.find((method) => method.IsDirectPayment === false);
  if (nonDirect) return nonDirect;

  return keywordMatch || methods[0];
}

function normalizeMobile(customerMobile) {
  if (!customerMobile) return null;

  const raw = String(customerMobile).trim();
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;

  if (digits.startsWith('966')) {
    return { countryCode: '+966', number: digits.slice(3) };
  }

  if (digits.startsWith('0')) {
    return { countryCode: '+966', number: digits.slice(1) };
  }

  return { countryCode: '+966', number: digits };
}

function getProviderFailureReason(statusResponse) {
  const data = statusResponse?.Data || {};
  return truncate(
    data.InvoiceError ||
      data.Error ||
      data.ErrorMessage ||
      statusResponse?.Message ||
      'Payment was not completed'
  );
}

function getProviderPaymentId(statusData, fallback) {
  if (statusData?.PaymentId) return String(statusData.PaymentId);

  const transactions = Array.isArray(statusData?.InvoiceTransactions)
    ? statusData.InvoiceTransactions
    : [];
  const transactionPaymentId = transactions.find((item) => item?.PaymentId)?.PaymentId;
  return asString(transactionPaymentId) || asString(fallback);
}

function logStatusVerificationFailure(err, source) {
  if (config.payment?.flowLogsEnabled) {
    logger.warn({
      source,
      error: {
        name: err?.name,
        code: err?.code,
        statusCode: err?.statusCode,
        message: err?.message,
        providerSummary: err?.providerSummary,
      },
    }, 'MyFatoorah payment status verification failed');
    return;
  }

  logger.warn({ source }, 'MyFatoorah payment status verification failed');
}

class PaymentService {
  _getCallbackUrls() {
    const baseUrl = normalizeBaseUrl(config.myfatoorah?.callbackBaseUrl);
    if (!baseUrl) {
      throw new AppError('Payment gateway callback URL is not configured', 500, 'PAYMENT_CALLBACK_URL_NOT_CONFIGURED');
    }

    return {
      callbackUrl: `${baseUrl}/api/v1/payments/myfatoorah/callback`,
      errorUrl: `${baseUrl}/api/v1/payments/myfatoorah/error`,
    };
  }

  _toPublicAttempt(paymentAttempt) {
    const output = typeof paymentAttempt?.toJSON === 'function'
      ? paymentAttempt.toJSON()
      : { ...paymentAttempt };
    delete output.providerResponse;
    return output;
  }

  async _audit({ attempt, action, newValues, auditContext }) {
    await auditService.log({
      tenantId: attempt.tenantId,
      userId: attempt.createdBy,
      action,
      resourceType: RESOURCE_TYPE,
      resourceId: attempt._id,
      newValues,
      auditContext,
    });
  }

  async _resolvePaymentMethodId({ amount, currency }) {
    const configuredPaymentMethodId = config.myfatoorah?.paymentMethodId;
    if (configuredPaymentMethodId) return Number(configuredPaymentMethodId);

    const initiateResponse = await myfatoorahClient.initiatePayment({ amount, currency });
    const methods = initiateResponse?.Data?.PaymentMethods || [];
    const method = pickPaymentMethod(methods);

    if (!method?.PaymentMethodId) {
      throw new AppError('Payment gateway has no available payment methods', 502, 'PAYMENT_METHOD_UNAVAILABLE');
    }

    return method.PaymentMethodId;
  }

  _buildExecutePaymentPayload({ attempt, paymentMethodId }) {
    const amount = toNumber(attempt.amount);
    const mobile = normalizeMobile(attempt.customerMobile);
    const payload = {
      PaymentMethodId: paymentMethodId,
      CustomerName: attempt.customerName,
      CustomerEmail: attempt.customerEmail,
      InvoiceValue: amount,
      DisplayCurrencyIso: attempt.currency,
      CallBackUrl: attempt.callbackUrl,
      ErrorUrl: attempt.errorUrl,
      Language: 'en',
      CustomerReference: attempt._id.toString(),
      UserDefinedField: attempt.referenceType || 'payment',
      InvoiceItems: [
        {
          ItemName: attempt.description || 'ARA Financial Payment',
          Quantity: 1,
          UnitPrice: amount,
        },
      ],
    };

    if (mobile?.number) {
      payload.MobileCountryCode = mobile.countryCode;
      payload.CustomerMobile = mobile.number;
    }

    return payload;
  }

  async createMyFatoorahPayment(tenantId, userId, data, options = {}) {
    const amount = String(data.amount);
    const currency = String(data.currency || 'EGP').toUpperCase();
    const { callbackUrl, errorUrl } = this._getCallbackUrls();

    const attempt = await PaymentAttempt.create({
      tenantId,
      createdBy: userId,
      provider: PROVIDER,
      status: 'pending',
      amount: toDecimal128(amount),
      currency,
      customerName: data.customerName,
      customerEmail: data.customerEmail,
      customerMobile: data.customerMobile || '',
      description: data.description || '',
      referenceType: data.referenceType || null,
      referenceId: data.referenceId || null,
      callbackUrl,
      errorUrl,
      metadata: data.metadata || null,
    });

    try {
      const numericAmount = toNumber(attempt.amount);
      const paymentMethodId = await this._resolvePaymentMethodId({ amount: numericAmount, currency });
      const executeResponse = await myfatoorahClient.executePayment(
        this._buildExecutePaymentPayload({ attempt, paymentMethodId })
      );
      const executeData = executeResponse?.Data || {};
      const paymentUrl = executeData.PaymentURL || executeData.PaymentUrl;
      const providerInvoiceId = executeData.InvoiceId ? String(executeData.InvoiceId) : null;

      if (!paymentUrl || !providerInvoiceId) {
        const error = new AppError(
          'Payment gateway did not return a payment URL',
          502,
          'PAYMENT_PROVIDER_INVALID_RESPONSE'
        );
        error.providerSummary = myfatoorahClient.summarizeResponse(executeResponse);
        throw error;
      }

      attempt.providerInvoiceId = providerInvoiceId;
      attempt.paymentUrl = paymentUrl;
      attempt.providerStatus = executeResponse?.Message || null;
      attempt.providerResponse = {
        executePayment: myfatoorahClient.summarizeResponse(executeResponse),
      };
      await attempt.save();

      await this._audit({
        attempt,
        action: 'payment.created',
        newValues: {
          provider: PROVIDER,
          status: attempt.status,
          amount,
          currency,
          providerInvoiceId,
        },
        auditContext: options.auditContext,
      });

      return {
        paymentAttempt: this._toPublicAttempt(attempt),
        paymentUrl,
      };
    } catch (err) {
      attempt.status = 'failed';
      attempt.failedAt = new Date();
      attempt.failureReason = 'Payment session creation failed';
      attempt.providerResponse = {
        ...(attempt.providerResponse || {}),
        error: err.providerSummary || { code: err.code || 'PAYMENT_PROVIDER_ERROR' },
      };
      await attempt.save();

      await this._audit({
        attempt,
        action: 'payment.failed',
        newValues: {
          provider: PROVIDER,
          status: attempt.status,
          amount,
          currency,
          reason: attempt.failureReason,
        },
        auditContext: options.auditContext,
      });

      throw err;
    }
  }

  async handleMyFatoorahCallback(query, options = {}) {
    return this._processMyFatoorahRedirect(query, {
      ...options,
      source: 'callback',
    });
  }

  async handleMyFatoorahError(query, options = {}) {
    return this._processMyFatoorahRedirect(query, {
      ...options,
      source: 'error',
    });
  }

  async _processMyFatoorahRedirect(query, options = {}) {
    const paymentKey = query.paymentId || query.PaymentId || query.Id || query.id;
    if (!paymentKey) {
      return {
        verified: false,
        status: 'failed',
        source: options.source,
        message: 'Payment identifier is missing',
      };
    }

    let statusResponse;
    try {
      statusResponse = await myfatoorahClient.getPaymentStatus({
        key: paymentKey,
        keyType: 'PaymentId',
      });
    } catch (err) {
      logStatusVerificationFailure(err, options.source);
      return {
        verified: false,
        status: 'failed',
        source: options.source,
        message: 'Payment status could not be verified',
      };
    }

    const statusData = statusResponse?.Data || {};
    const providerInvoiceId = asString(statusData.InvoiceId);
    const providerPaymentId = getProviderPaymentId(statusData, paymentKey);
    const mappedStatus = mapInvoiceStatus(statusData.InvoiceStatus);
    const attempt = await this._findAttemptFromProviderStatus({
      providerInvoiceId,
      providerPaymentId,
    });

    if (!attempt) {
      return {
        verified: true,
        status: mappedStatus,
        source: options.source,
        providerInvoiceId,
        providerPaymentId,
        message: 'Payment attempt was not found',
      };
    }

    await this._audit({
      attempt,
      action: 'payment.verified',
      newValues: {
        provider: PROVIDER,
        providerStatus: statusData.InvoiceStatus || null,
        status: mappedStatus,
        providerInvoiceId,
        providerPaymentId,
      },
      auditContext: options.auditContext,
    });

    if (attempt.status === 'paid') {
      return {
        verified: true,
        status: 'paid',
        source: options.source,
        alreadyProcessed: true,
        paymentAttemptId: attempt._id,
        providerInvoiceId,
        providerPaymentId,
      };
    }

    if (mappedStatus === 'paid') {
      return this._markAttemptPaid({
        attempt,
        statusResponse,
        providerInvoiceId,
        providerPaymentId,
        auditContext: options.auditContext,
        source: options.source,
      });
    }

    return this._markAttemptNotPaid({
      attempt,
      status: mappedStatus,
      statusResponse,
      providerInvoiceId,
      providerPaymentId,
      auditContext: options.auditContext,
      source: options.source,
    });
  }

  async _findAttemptFromProviderStatus({ providerInvoiceId, providerPaymentId }) {
    if (providerInvoiceId) {
      const byInvoice = await PaymentAttempt.findOne({
        provider: PROVIDER,
        providerInvoiceId,
      }).setOptions({ __skipTenantFilter: true });

      if (byInvoice) return byInvoice;
    }

    if (providerPaymentId) {
      return PaymentAttempt.findOne({
        provider: PROVIDER,
        providerPaymentId,
      }).setOptions({ __skipTenantFilter: true });
    }

    return null;
  }

  async _markAttemptPaid({
    attempt,
    statusResponse,
    providerInvoiceId,
    providerPaymentId,
    auditContext,
    source,
  }) {
    const statusData = statusResponse?.Data || {};
    const providerAmount = parseProviderAmount(statusData.InvoiceValue);
    const expectedAmount = toNumber(attempt.amount);

    if (
      providerAmount !== null &&
      expectedAmount !== null &&
      Math.abs(providerAmount - expectedAmount) > 0.01
    ) {
      return this._markAttemptNotPaid({
        attempt,
        status: 'failed',
        statusResponse,
        providerInvoiceId,
        providerPaymentId,
        auditContext,
        source,
        failureReason: 'Provider amount mismatch',
      });
    }

    const providerCustomerReference = asString(statusData.CustomerReference);
    if (providerCustomerReference && providerCustomerReference !== attempt._id.toString()) {
      return this._markAttemptNotPaid({
        attempt,
        status: 'failed',
        statusResponse,
        providerInvoiceId,
        providerPaymentId,
        auditContext,
        source,
        failureReason: 'Provider customer reference mismatch',
      });
    }

    const now = new Date();
    const providerResponse = {
      ...(attempt.providerResponse || {}),
      getPaymentStatus: myfatoorahClient.summarizeResponse(statusResponse),
    };

    const updated = await PaymentAttempt.findOneAndUpdate(
      { _id: attempt._id, tenantId: attempt.tenantId, status: { $ne: 'paid' } },
      {
        status: 'paid',
        providerInvoiceId: providerInvoiceId || attempt.providerInvoiceId,
        providerPaymentId: providerPaymentId || attempt.providerPaymentId,
        providerStatus: statusData.InvoiceStatus || null,
        providerResponse,
        paidAt: now,
        failedAt: null,
        failureReason: null,
      },
      { new: true }
    );

    const paymentAttempt = updated || attempt;
    if (updated) {
      await this._audit({
        attempt: updated,
        action: 'payment.paid',
        newValues: {
          provider: PROVIDER,
          status: 'paid',
          providerInvoiceId: updated.providerInvoiceId,
          providerPaymentId: updated.providerPaymentId,
          paidAt: now,
        },
        auditContext,
      });
    }

    return {
      verified: true,
      status: 'paid',
      source,
      alreadyProcessed: !updated,
      paymentAttemptId: paymentAttempt._id,
      providerInvoiceId: paymentAttempt.providerInvoiceId,
      providerPaymentId: paymentAttempt.providerPaymentId,
    };
  }

  async _markAttemptNotPaid({
    attempt,
    status,
    statusResponse,
    providerInvoiceId,
    providerPaymentId,
    auditContext,
    source,
    failureReason,
  }) {
    const statusData = statusResponse?.Data || {};
    const nextStatus = status === 'paid' ? 'failed' : status;
    const terminalFailureStatuses = ['failed', 'cancelled', 'expired'];
    const isTerminalFailure = terminalFailureStatuses.includes(nextStatus);
    const now = new Date();
    const providerResponse = {
      ...(attempt.providerResponse || {}),
      getPaymentStatus: myfatoorahClient.summarizeResponse(statusResponse),
    };
    const reason = failureReason || (isTerminalFailure ? getProviderFailureReason(statusResponse) : null);

    const updated = await PaymentAttempt.findOneAndUpdate(
      { _id: attempt._id, tenantId: attempt.tenantId, status: { $ne: 'paid' } },
      {
        status: nextStatus,
        providerInvoiceId: providerInvoiceId || attempt.providerInvoiceId,
        providerPaymentId: providerPaymentId || attempt.providerPaymentId,
        providerStatus: statusData.InvoiceStatus || null,
        providerResponse,
        failedAt: isTerminalFailure ? now : attempt.failedAt,
        failureReason: reason,
      },
      { new: true }
    );

    const paymentAttempt = updated || attempt;
    if (updated && isTerminalFailure && attempt.status !== nextStatus) {
      await this._audit({
        attempt: updated,
        action: 'payment.failed',
        newValues: {
          provider: PROVIDER,
          status: nextStatus,
          providerInvoiceId: updated.providerInvoiceId,
          providerPaymentId: updated.providerPaymentId,
          reason,
        },
        auditContext,
      });
    }

    return {
      verified: true,
      status: paymentAttempt.status,
      source,
      alreadyProcessed: !updated,
      paymentAttemptId: paymentAttempt._id,
      providerInvoiceId: paymentAttempt.providerInvoiceId,
      providerPaymentId: paymentAttempt.providerPaymentId,
    };
  }
}

module.exports = new PaymentService();
