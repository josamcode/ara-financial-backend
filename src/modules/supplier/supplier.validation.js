'use strict';

const { z } = require('zod');

const createSupplierSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().max(50).optional().default(''),
  address: z.string().max(500).optional().default(''),
  notes: z.string().max(2000).optional().default(''),
});

const updateSupplierSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().max(50).optional(),
  address: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
});

module.exports = { createSupplierSchema, updateSupplierSchema };
