// Fourteen. Resist adding more — categories you don't use become noise.
export const CATEGORIES = [
  'Food & Dining',
  'Groceries',
  'Transport',
  'Shopping',
  'Bills & Utilities',
  'Rent',
  'Health',
  'Entertainment',
  'Education',
  'Personal Care',
  'Household Help',
  'Transfers',
  'Income',
  'Other',
]

// One colour per category, used for the dot in the ledger and the bars in the
// dashboard. Muted on purpose — the amount is the loud thing, not the dot.
export const CATEGORY_COLOR = {
  'Food & Dining': '#E8A33D',
  Groceries: '#8FBF6A',
  Transport: '#6FA8DC',
  Shopping: '#C88CC4',
  'Bills & Utilities': '#7FB0A5',
  Rent: '#B98A5E',
  Health: '#D9634F',
  Entertainment: '#A98CD9',
  Education: '#6FB3A0',
  'Personal Care': '#D9A0B8',
  'Household Help': '#9AA37E',
  Transfers: '#6C7378',
  Income: '#6FB3A0',
  Other: '#8A8F94',
}

export const colorFor = (c) => CATEGORY_COLOR[c] ?? CATEGORY_COLOR.Other

// Types that are real spending. Everything else is money moving, not leaving.
export const SPEND_TYPES = ['expense']
export const TYPES = ['expense', 'income', 'transfer', 'refund', 'lent', 'repaid']
