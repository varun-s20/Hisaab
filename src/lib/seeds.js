// Tier 3 of the cascade: brands common enough in India that paying an LLM to
// recognise them would be silly. Matched against the normalised payee string.
// Add to this list whenever the same merchant shows up in the weekly cleanup
// twice — it's cheaper than a round trip forever.

export const SEED_RULES = [
  // Food & Dining
  [/SWIGGY|ZOMATO|EATSURE|FAASOS|BEHROUZ|OVENSTORY|DOMINO|PIZZAHUT|MCDONALD|BURGERKING|KFC|SUBWAY|STARBUCKS|CHAIPOINT|CHAAYOS|BARBEQUE|HALDIRAM|BIKANERVALA|CAFE|RESTAURANT|BAKERY|DHABA|BIRYANI/i, 'Food & Dining'],
  // Groceries
  [/BLINKIT|GROFERS|ZEPTO|BIGBASKET|DUNZO|INSTAMART|JIOMART|DMART|RELIANCEFRESH|MORESUPERMARKET|SPENCERS|KIRANA|GENERALSTORE|VEGETABLE|SABZI|DAIRY|MILK|AMUL|MOTHERDAIRY/i, 'Groceries'],
  // Transport
  [/UBER|OLA|RAPIDO|IRCTC|REDBUS|ABHIBUS|INDIGO|SPICEJET|AIRINDIA|VISTARA|METRO|DMRC|LMRC|FASTAG|NETC|PETROL|FUEL|HPCL|BHARATPETROL|IOCL|INDIANOIL|SHELL|AUTO|CAB|TAXI|PARKING/i, 'Transport'],
  // Shopping
  [/AMAZON|FLIPKART|MYNTRA|AJIO|MEESHO|NYKAAFASHION|SNAPDEAL|TATACLIQ|DECATHLON|LIFESTYLE|PANTALOON|WESTSIDE|ZARA|HANDM|UNIQLO|IKEA|CROMA|RELIANCEDIGITAL|VIJAYSALES/i, 'Shopping'],
  // Bills & Utilities
  //
  // Insurance and loan instalments live here, and used to sit in Transfers with
  // the brokers below. A `transfer` is in NO total on any screen — that is the
  // whole meaning of the type — so an LIC premium and a ₹22,000 EMI were money
  // that left the account and appeared in nobody's spending, every month, for as
  // long as the app has existed. Neither is your own money moving between your
  // own pockets: the premium is gone, and the instalment is gone whatever it
  // does to a balance sheet. A recurring obligation is what this category is.
  //
  // `^LIC` and not `\bLIC\b`: these are matched against normalise()'d text with
  // every space and dot already stripped, so the only word boundaries left are
  // the two ends of the string — "LIC OF INDIA" is LICOFINDIA, where `\b` finds
  // nothing. Anchored, not bare, because bare LIC is inside PUBLIC and POLICY.
  [/JIO|AIRTEL|VODAFONE|\bVI\b|BSNL|ACTFIBER|HATHWAY|TATAPLAY|DISHTV|ELECTRICITY|UPPCL|BESCOM|MSEDCL|TORRENTPOWER|ADANIELECTRICITY|GASBILL|INDANE|HPGAS|BHARATGAS|WATERBILL|JALKAL|BROADBAND|RECHARGE|POSTPAID|PREPAID|LOANEMI|\bEMI\b|^LIC|INSURANCE|POLICYBAZAAR/i, 'Bills & Utilities'],
  // Rent
  [/RENT|NOBROKER|NESTAWAY|LANDLORD|MAINTENANCE|SOCIETY|RWA|HOUSINGSOCIETY/i, 'Rent'],
  // Health
  [/APOLLO|PHARMEASY|NETMEDS|1MG|TATA1MG|MEDPLUS|WELLNESSFOREVER|DIAGNOSTIC|PATHOLOGY|DRLAL|METROPOLIS|THYROCARE|HOSPITAL|CLINIC|PHARMACY|CHEMIST|MEDICAL|DENTAL|OPTICAL|LENSKART/i, 'Health'],
  // Entertainment
  [/NETFLIX|PRIMEVIDEO|HOTSTAR|DISNEY|SONYLIV|ZEE5|JIOCINEMA|SPOTIFY|GAANA|WYNK|YOUTUBEPREMIUM|BOOKMYSHOW|PVR|INOX|CINEPOLIS|STEAM|PLAYSTATION|XBOX|NINTENDO/i, 'Entertainment'],
  // Education
  [/UDEMY|COURSERA|UNACADEMY|BYJU|VEDANTU|PHYSICSWALLAH|SKILLSHARE|DUOLINGO|SCHOOL|COLLEGE|UNIVERSITY|TUITION|COACHING|EXAMFEE|LIBRARY/i, 'Education'],
  // Personal Care
  [/NYKAA|MAMAEARTH|SALON|SPA|BARBER|LAKME|URBANCOMPANY|URBANCLAP|GYM|CULTFIT|FITNESS|YOGA/i, 'Personal Care'],
  // Household Help
  [/MAID|COOK|DRIVER|HELPER|CLEANER|ISTRI|DHOBI|LAUNDRY|PRESSWALA|MALI|GARDENER|SECURITY|GUARD/i, 'Household Help'],
  // Transfers — money moving, not spending.
  //
  // The brokers and the deposits stay here, and that is deliberate rather than
  // an oversight: an SIP or a fixed deposit really is your own money changing
  // pockets, which is what this type means. The app has a separate `investment`
  // type with its own total and its own view on Insights, and it is set by hand
  // on purpose — nothing in a payee string can tell a ₹5,000 SIP from a ₹5,000
  // withdrawal to the same broker, and guessing wrong writes the difference into
  // a figure headed "invested". Retype a row and every future payment to that
  // merchant follows it.
  [/CRED|CREDITCARD|CARDPAYMENT|CCPAYMENT|BILLPAYMENT.*CARD|SELFTRANSFER|OWNACCOUNT|GROWW|ZERODHA|UPSTOX|COIN|KUVERA|INDMONEY|SIP|MUTUALFUND|PPF|NPS|FIXEDDEPOSIT|\bFD\b|RECURRINGDEPOSIT/i, 'Transfers'],
]

// Category → the type it implies. Anything unmapped stays 'expense'.
export const TYPE_FOR_CATEGORY = {
  Transfers: 'transfer',
  Income: 'income',
}

/** Normalise a payee for matching and for the merchant_map key. */
export function normalise(payee) {
  return String(payee ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9@]/g, '')
    .replace(/\d{4,}$/, '') // trailing terminal/QR ids: BHARATPE09283746 → BHARATPE
    .trim()
}

export function seedLookup(payee) {
  const n = normalise(payee)
  if (!n) return null
  return SEED_RULES.find(([re]) => re.test(n))?.[1] ?? null
}
