'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const requestLogger = require('./common/middleware/requestLogger');
const errorHandler = require('./common/middleware/errorHandler');
const { NotFoundError } = require('./common/errors');
const config = require('./config');

function createCorsOptions() {
  const { allowedOrigins } = config.cors;
  const allowAllOrigins = config.env !== 'production' && allowedOrigins.length === 0;

  return {
    origin(origin, callback) {
      if (!origin || allowAllOrigins) {
        callback(null, true);
        return;
      }

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(null, false);
    },
  };
}

function createApp() {
  const app = express();
  app.set('trust proxy', config.http.trustProxy);

  // ── Security & parsing ─────────────────────────
  app.use(helmet());
  app.use(cors(createCorsOptions()));
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ── Request logging ────────────────────────────
  app.use(requestLogger);

  // ── Health check (unprotected) ─────────────────
  app.get('/api/v1/health', (_req, res) => {
    res.json({
      success: true,
      data: {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      },
    });
  });

  // ── API routes (registered after module loading) ─
  const authRoutes = require('./modules/auth/auth.routes');
  const userRoutes = require('./modules/user/user.routes');
  const tenantRoutes = require('./modules/tenant/tenant.routes');
  const accountRoutes = require('./modules/account/account.routes');
  const fiscalPeriodRoutes = require('./modules/fiscal-period/fiscalPeriod.routes');
  const journalRoutes = require('./modules/journal/journal.routes');
  const ledgerRoutes = require('./modules/ledger/ledger.routes');
  const reportRoutes = require('./modules/report/report.routes');
  const dashboardRoutes = require('./modules/dashboard/dashboard.routes');
  const auditRoutes = require('./modules/audit/audit.routes');
  const invoiceRoutes = require('./modules/invoice/invoice.routes');
  const customerRoutes = require('./modules/customer/customer.routes');
  const supplierRoutes = require('./modules/supplier/supplier.routes');
  const billRoutes = require('./modules/bill/bill.routes');

  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/users', userRoutes);
  app.use('/api/v1/tenants', tenantRoutes);
  app.use('/api/v1/accounts', accountRoutes);
  app.use('/api/v1/fiscal-periods', fiscalPeriodRoutes);
  app.use('/api/v1/journal-entries', journalRoutes);
  app.use('/api/v1/ledger', ledgerRoutes);
  app.use('/api/v1/reports', reportRoutes);
  app.use('/api/v1/dashboard', dashboardRoutes);
  app.use('/api/v1/audit-logs', auditRoutes);
  app.use('/api/v1/invoices', invoiceRoutes);
  app.use('/api/v1/customers', customerRoutes);
  app.use('/api/v1/suppliers', supplierRoutes);
  app.use('/api/v1/bills', billRoutes);

  // ── 404 handler ────────────────────────────────
  app.use((_req, _res, next) => {
    next(new NotFoundError('Route not found'));
  });

  // ── Global error handler ───────────────────────
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
