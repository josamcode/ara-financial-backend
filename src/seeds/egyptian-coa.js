'use strict';

/**
 * Egyptian Commercial Chart of Accounts Template.
 * Based on standard Egyptian accounting practices.
 * 
 * Code structure:
 *   1xxx = Assets
 *   2xxx = Liabilities
 *   3xxx = Equity
 *   4xxx = Revenue
 *   5xxx = Expenses
 */
const EGYPTIAN_COA_TEMPLATE = [
  // ── ASSETS (1xxx) ──────────────────────────────
  { code: '1000', nameAr: 'الأصول', nameEn: 'Assets', type: 'asset', nature: 'debit', level: 1, isParentOnly: true },
  
  // Current Assets
  { code: '1100', nameAr: 'الأصول المتداولة', nameEn: 'Current Assets', type: 'asset', nature: 'debit', level: 2, parentCode: '1000', isParentOnly: true },
  { code: '1110', nameAr: 'النقدية وما في حكمها', nameEn: 'Cash and Cash Equivalents', type: 'asset', nature: 'debit', level: 3, parentCode: '1100', isParentOnly: true },
  { code: '1111', nameAr: 'الصندوق', nameEn: 'Cash on Hand', type: 'asset', nature: 'debit', level: 4, parentCode: '1110' },
  { code: '1112', nameAr: 'البنك', nameEn: 'Bank Account', type: 'asset', nature: 'debit', level: 4, parentCode: '1110' },
  { code: '1120', nameAr: 'المدينون', nameEn: 'Accounts Receivable', type: 'asset', nature: 'debit', level: 3, parentCode: '1100' },
  { code: '1130', nameAr: 'المخزون', nameEn: 'Inventory', type: 'asset', nature: 'debit', level: 3, parentCode: '1100' },
  { code: '1140', nameAr: 'مصروفات مدفوعة مقدماً', nameEn: 'Prepaid Expenses', type: 'asset', nature: 'debit', level: 3, parentCode: '1100' },

  // Fixed Assets
  { code: '1200', nameAr: 'الأصول الثابتة', nameEn: 'Fixed Assets', type: 'asset', nature: 'debit', level: 2, parentCode: '1000', isParentOnly: true },
  { code: '1210', nameAr: 'الأراضي', nameEn: 'Land', type: 'asset', nature: 'debit', level: 3, parentCode: '1200' },
  { code: '1220', nameAr: 'المباني', nameEn: 'Buildings', type: 'asset', nature: 'debit', level: 3, parentCode: '1200' },
  { code: '1230', nameAr: 'الأثاث والتجهيزات', nameEn: 'Furniture and Fixtures', type: 'asset', nature: 'debit', level: 3, parentCode: '1200' },
  { code: '1240', nameAr: 'أجهزة الحاسب الآلي', nameEn: 'Computer Equipment', type: 'asset', nature: 'debit', level: 3, parentCode: '1200' },
  { code: '1250', nameAr: 'السيارات', nameEn: 'Vehicles', type: 'asset', nature: 'debit', level: 3, parentCode: '1200' },
  { code: '1290', nameAr: 'مجمع الإهلاك', nameEn: 'Accumulated Depreciation', type: 'asset', nature: 'credit', level: 3, parentCode: '1200' },

  // ── LIABILITIES (2xxx) ──────────────────────────
  { code: '2000', nameAr: 'الالتزامات', nameEn: 'Liabilities', type: 'liability', nature: 'credit', level: 1, isParentOnly: true },
  
  // Current Liabilities
  { code: '2100', nameAr: 'الالتزامات المتداولة', nameEn: 'Current Liabilities', type: 'liability', nature: 'credit', level: 2, parentCode: '2000', isParentOnly: true },
  { code: '2110', nameAr: 'الدائنون', nameEn: 'Accounts Payable', type: 'liability', nature: 'credit', level: 3, parentCode: '2100' },
  { code: '2120', nameAr: 'مصروفات مستحقة', nameEn: 'Accrued Expenses', type: 'liability', nature: 'credit', level: 3, parentCode: '2100' },
  { code: '2130', nameAr: 'إيرادات مقدمة', nameEn: 'Unearned Revenue', type: 'liability', nature: 'credit', level: 3, parentCode: '2100' },
  { code: '2140', nameAr: 'ضريبة القيمة المضافة', nameEn: 'VAT Payable', type: 'liability', nature: 'credit', level: 3, parentCode: '2100' },

  // Long-Term Liabilities
  { code: '2200', nameAr: 'الالتزامات طويلة الأجل', nameEn: 'Long-Term Liabilities', type: 'liability', nature: 'credit', level: 2, parentCode: '2000', isParentOnly: true },
  { code: '2210', nameAr: 'قروض طويلة الأجل', nameEn: 'Long-Term Loans', type: 'liability', nature: 'credit', level: 3, parentCode: '2200' },

  // ── EQUITY (3xxx) ──────────────────────────────
  { code: '3000', nameAr: 'حقوق الملكية', nameEn: 'Equity', type: 'equity', nature: 'credit', level: 1, isParentOnly: true },
  { code: '3100', nameAr: 'رأس المال', nameEn: 'Capital', type: 'equity', nature: 'credit', level: 2, parentCode: '3000' },
  { code: '3200', nameAr: 'الأرباح المحتجزة', nameEn: 'Retained Earnings', type: 'equity', nature: 'credit', level: 2, parentCode: '3000', systemAccount: true },
  { code: '3300', nameAr: 'أرباح/خسائر العام', nameEn: 'Current Year Earnings', type: 'equity', nature: 'credit', level: 2, parentCode: '3000', systemAccount: true },
  { code: '3400', nameAr: 'حساب جاري الشريك', nameEn: 'Owner Drawing', type: 'equity', nature: 'debit', level: 2, parentCode: '3000' },

  // ── REVENUE (4xxx) ──────────────────────────────
  { code: '4000', nameAr: 'الإيرادات', nameEn: 'Revenue', type: 'revenue', nature: 'credit', level: 1, isParentOnly: true },
  { code: '4100', nameAr: 'إيرادات المبيعات', nameEn: 'Sales Revenue', type: 'revenue', nature: 'credit', level: 2, parentCode: '4000' },
  { code: '4200', nameAr: 'إيرادات خدمات', nameEn: 'Service Revenue', type: 'revenue', nature: 'credit', level: 2, parentCode: '4000' },
  { code: '4300', nameAr: 'إيرادات أخرى', nameEn: 'Other Revenue', type: 'revenue', nature: 'credit', level: 2, parentCode: '4000' },
  { code: '4310', nameAr: 'أرباح فروق العملة', nameEn: 'Foreign Exchange Gain', type: 'revenue', nature: 'credit', level: 2, parentCode: '4000' },
  { code: '4400', nameAr: 'خصومات ومردودات المبيعات', nameEn: 'Sales Discounts and Returns', type: 'revenue', nature: 'debit', level: 2, parentCode: '4000' },

  // ── EXPENSES (5xxx) ──────────────────────────────
  { code: '5000', nameAr: 'المصروفات', nameEn: 'Expenses', type: 'expense', nature: 'debit', level: 1, isParentOnly: true },
  { code: '5100', nameAr: 'تكلفة المبيعات', nameEn: 'Cost of Goods Sold', type: 'expense', nature: 'debit', level: 2, parentCode: '5000' },
  { code: '5200', nameAr: 'الرواتب والأجور', nameEn: 'Salaries and Wages', type: 'expense', nature: 'debit', level: 2, parentCode: '5000' },
  { code: '5300', nameAr: 'الإيجار', nameEn: 'Rent Expense', type: 'expense', nature: 'debit', level: 2, parentCode: '5000' },
  { code: '5400', nameAr: 'المرافق', nameEn: 'Utilities', type: 'expense', nature: 'debit', level: 2, parentCode: '5000' },
  { code: '5500', nameAr: 'مصروفات الإهلاك', nameEn: 'Depreciation Expense', type: 'expense', nature: 'debit', level: 2, parentCode: '5000' },
  { code: '5600', nameAr: 'مصروفات تسويق', nameEn: 'Marketing Expense', type: 'expense', nature: 'debit', level: 2, parentCode: '5000' },
  { code: '5700', nameAr: 'مصروفات إدارية', nameEn: 'Administrative Expense', type: 'expense', nature: 'debit', level: 2, parentCode: '5000' },
  { code: '5800', nameAr: 'مصروفات بنكية', nameEn: 'Bank Charges', type: 'expense', nature: 'debit', level: 2, parentCode: '5000' },
  { code: '5900', nameAr: 'مصروفات أخرى', nameEn: 'Other Expenses', type: 'expense', nature: 'debit', level: 2, parentCode: '5000' },
  { code: '5910', nameAr: 'خسائر فروق العملة', nameEn: 'Foreign Exchange Loss', type: 'expense', nature: 'debit', level: 2, parentCode: '5000' },
];

module.exports = EGYPTIAN_COA_TEMPLATE;
