/** UI string literals — tooltip text, labels, messages, empty states. */

export const STR = {
  // ── Nav: buy-mode tooltips ────────────────────────────────────────────────
  BUY_MODE_1TAP:    '1-Tap buy — cycle mode',
  BUY_MODE_MARKET:  'Market buy — cycle mode',
  BUY_MODE_LIMIT:   'Limit buy — cycle mode',

  // ── Nav: mode / service toggles ───────────────────────────────────────────
  PRACTICE_ON:      'Practice — switch to real',
  PRACTICE_OFF:     'Real money — switch to practice',
  REFILL:           'Refill to $100',
  WALLET_OPEN:      'Back to trading',
  WALLET_CLOSED:    'Wallet — send / receive',
  SIGN_WALLET:      'Wallet signing (preview) — click for Instant',
  SIGN_INSTANT:     'Instant signing — click for browser-wallet (preview)',
  THEME_TOGGLE:     'Toggle light / dark',

  // ── Nav: stat strip labels ────────────────────────────────────────────────
  STAT_CASH:    'CASH',
  STAT_SPEND:   'SPEND',
  STAT_WALLET:  'WALLET',
  STAT_PROFIT:  'PROFIT',
  STAT_ACC:     'ACC',
  STAT_WINS:    'WINS',
  STAT_LOSS:    'LOSS',
  STAT_OUT:     'OUT',
  STAT_RECORD:  'W–L',
  GRP_WALLET:   'Wallet',
  GRP_PERF:     'Performance',

  // ── Trading bar ───────────────────────────────────────────────────────────
  // Shown on the disabled buy control in live mode. It used to read "Add
  // credentials in .env to trade", which named only ONE of the three signers —
  // and the riskiest one at that. All three start in the Wallet panel.
  NO_SIGNER:      'Connect a wallet to trade',
  PRACTICE_RESET: 'Practice reset to $100',
  STATUS_BUY:     'Placing order…',
  STATUS_OK:      'Practice mode ON',
  STATUS_OFF:     'Practice mode OFF',

  // ── Connection banners ────────────────────────────────────────────────────
  SSE_DOWN:      'SSE disconnected — reconnecting…',
  FEED_DEGRADED: 'Market feed unreachable from server — retrying…',

  // ── Empty states ──────────────────────────────────────────────────────────
  NO_POSITIONS:  'No open positions',
  NO_POSITIONS_HINT: 'Buy a contract to open a position.',
  NO_TRADES:     'No trades in this window yet.',
  NO_HOLDERS:    'No holders in this window yet.',
  NO_POSITIONS_W: 'No positions in this window yet.',
  NO_COMMENTS:   'No comments yet.',
  NO_ACTIVITY:   'No recent activity.',

  // ── Market panel tabs ─────────────────────────────────────────────────────
  TAB_ACTIVITY:  'Activity',
  TAB_HOLDERS:   'Holders',
  TAB_POSITIONS: 'Positions',
  TAB_COMMENTS:  'Comments',

  // ── Chart overlay ─────────────────────────────────────────────────────────
  PAST_WINDOW:   'PAST WINDOW',
  NEXT_WINDOW:   'NEXT WINDOW',
  OPENS_SOON:    'OPENS SOON',

  // ── Wallet panel ─────────────────────────────────────────────────────────
  WALLET_SEND_HEADER:    'SEND USDC',
  WALLET_RECEIVE_HEADER: 'RECEIVE USDC',
  WALLET_ENABLE_HEADER:  'ENABLE TRADING',
  WALLET_CLAIM_HEADER:   'CLAIM WINNINGS',
  WALLET_BROWSER_HEADER: 'BROWSER WALLET',
  WALLET_ACTIVITY_HEADER: 'ACTIVITY',
  WALLET_APPROVE_BTN:    'Approve once (uses POL gas)',
  WALLET_CLAIM_BTN:      'Claim resolved winnings',
  WALLET_GENERATE_BTN:   'Generate trading wallet',
  WALLET_SEND_AMOUNT:    'Amount (USDC)',
  WALLET_SEND_DEST:      'Destination 0x…',
  WALLET_PREVIEW_BADGE:  'PREVIEW',

  // ── Time-window carousel (WindowNav) ──────────────────────────────────────
  WIN_EARLIER:   'Earlier',
  WIN_LATER:     'Later',
  WIN_BACK_LIVE: 'Back to live',
  WIN_DRAG:      'Drag to reorder',
  WIN_PAST:      'PAST',
  WIN_NEXT:      'NEXT',
  WIN_LIVE:      'LIVE',

  // ── Nav stat-chip detail copy ─────────────────────────────────────────────
  DET_CASH:    'free to trade',
  DET_SPEND:   'spendable right now',
  DET_WALLET:  'on-chain balance',
  DET_PROFIT:  'all-time P&L',
  DET_ACC:     'your win rate',
  DET_RECORD:  'wins vs losses',

  // ── Sides / directions ────────────────────────────────────────────────────
  UP:   'Up',
  DOWN: 'Down',
  REC:  'REC',

  // ── Trading bar ───────────────────────────────────────────────────────────
  BUY:            'Buy',
  SELL:           'Sell',
  BOOK:           'Book',
  BUY_UP:         'Buy Up',
  BUY_DOWN:       'Buy Down',
  LIMIT_UP:       'Limit Up',
  LIMIT_DOWN:     'Limit Down',
  SELL_ALL:       'Sell all',
  SELL_BADGE:     'SELL',
  SELL_SIZE:      'SELL SIZE',
  SIZE_ALL:       'All',
  CLAIM:          'Claim',
  TO_WIN:         'To win',
  YOU_PAY:        'You pay',
  MAX_PRICE:      'Max price',
  AMOUNT:         'Amount',
  COST_BASIS:     'cost basis',
  REFRESH_POS:    'Refresh positions',
  FETCHING_POS:   'Fetching positions…',
  BM_1TAP:        '1-Tap',
  BM_MARKET:      'Market',
  BM_LIMIT:       'Limit',
  BM_TAP_CHANGE:  '· tap to change',
  PRESET_SELECT_HINT: 'Tap to select · double-tap to edit',
  PRESET_EDIT_HINT:   'Right-click to set a custom amount',
  STAT_OPEN:      'OPEN',
  STAT_SETTLE:    'SETTLE',
  STAT_CHANGE:    'CHANGE',
  BACK_TO_LIVE:   'BACK TO LIVE',
  RESOLVING:      'RESOLVING…',
  WINDOW_FLAT:    "Window hasn't opened yet — pricing flat at 50/50.",

  // ── Order book / market panel ─────────────────────────────────────────────
  OB_TRADE_UP:    'Trade Up',
  OB_TRADE_DOWN:  'Trade Down',
  OB_REFRESH:     'Refresh',
  COL_PRICE:      'PRICE',
  COL_SHARES:     'SHARES',
  COL_TOTAL:      'TOTAL',
  COL_PNL:        'PNL',
  COL_ASKS:       'Asks',
  HOLDERS_UP:     'Up holders',
  HOLDERS_DOWN:   'Down holders',

  // ── Live trades feed ──────────────────────────────────────────────────────
  TAG_PRICE:  'PRICE',
  TAG_TRADE:  'TRADE',
  TAG_CHAT:   'CHAT',
  ANON:       'anon',

  // ── Wallet panel (sections / labels / pills) ──────────────────────────────
  WALLET_TITLE:       'Wallet',
  WALLET_SEC_BAL:     'Balances',
  WALLET_SEC_SWAP:    'Swap',
  WALLET_SEC_SEND:    'Send',
  WALLET_SEC_MODE:    'Wallet Mode',
  WALLET_MODE_SERVER: 'Server Wallet',
  WALLET_MODE_BROWSER: 'Browser Wallet',
  WALLET_GET_GAS:     'Get gas (POL)',
  WALLET_MAX:         'MAX',
  WALLET_REMOVE:      'REMOVE',
  WALLET_DETECTED:    'DETECTED',
  WALLET_INSTALL:     'Install',
  WALLET_ON_POLY:     'On Polymarket',
  WALLET_GAS_BAL:     'Gas Balance',
  WALLET_USE_ALL:     'Available — tap to use all',
  WALLET_COPY:        'Copy address',
  WALLET_REFRESH:     'Refresh & claim',

  // ── Mobile bottom tabs ────────────────────────────────────────────────────
  TAB_HOME:   'Home',
  TAB_WALLET: 'Wallet',
  TAB_TRADE:  'Trade',
  TAB_REFILL: 'Refill',
  TAB_GAME:   'Game',
  TAB_REAL:   'Real',
  // Mobile mode tab names the DESTINATION. The old labels named the current state,
  // so the button reading "Game" was the one that switched to real money.
  TAB_GO_REAL: 'Go Real',
  TAB_GO_GAME: 'Go Game',
  CONFIRM_GO_REAL:
    'Switch to REAL money?\n\nOrders will spend actual funds from your wallet and are irreversible.',
  TAB_MARKET: 'Market',
  TAB_ACTIVITY_M: 'Activity',

  // ── Misc ──────────────────────────────────────────────────────────────────
  DASH:    '—',
  LOADING: 'Loading…',
} as const
