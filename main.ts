// Clean-Flow: a fresh-mint flow bot for the Pump.fun Sharpe Sprint.
//
// The idea is simple: catch a new pump.fun coin in its first seconds, while
// the creator still holds a modest stake and has not sold, and ride the
// early flow for a short, strictly capped hold. Slightly older coins get one
// small probe only, and one of the five position slots is always kept free
// for the next fresh mint.
//
// Exits are mechanical and total: +20% take-profit, -15% stop-loss, a
// 200-slot max hold, or the creator selling. Nothing here reads the clock,
// the environment, or any randomness, so two runs decide the same orders.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type Curve,
  type Holding,
  type OrderInput,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

const SOL = LAMPORTS_PER_SOL;

// Tier A: a fresh mint, age in slots since its CreateEvent.
const TIER_A_MAX_AGE = 8;
const CREATOR_MIN_SOL = (SOL * 15n) / 100n; // 0.15 SOL
// 2.0 SOL, not 2.5: creators who spent 2–2.5 SOL run measurably worse on
// the dev window (bigger dev buys, more likely to sell into the flow),
// and the tighter cap lands the entry count on the target.
const CREATOR_MAX_SOL = SOL * 2n; // 2.0 SOL
const RESERVE_MIN_SOL = SOL * 3n;
const RESERVE_MAX_SOL = SOL * 50n;
const TIER_A_MIN_TRADES = 4;
const TIER_A_MIN_BUYERS = 4;
const PYRAMID_CAP_SOL = SOL * 2n; // total position size, Tier A
// Pyramid adds only run inside this age window: the 1%-of-reserves cap
// times a short window is what binds the build, so adds stop early even
// while the position is still Tier A eligible.
const PYRAMID_MAX_AGE = 6;

// Tier B: a slightly older mint, one small probe, never pyramided.
const TIER_B_MIN_AGE = 9;
const TIER_B_MAX_AGE = 20;
const TIER_B_MIN_TRADES = 3;
const TIER_B_MIN_BUYERS = 3;
const TIER_B_SIZE_SOL = SOL / 10n; // 0.1 SOL

// A round trip only counts toward the guardrail at 0.01 SOL or more.
const MIN_BUY_SOL = SOL / 100n;

// Exits: full sell on any trigger.
const TAKE_PROFIT_NUM = 120n; // value >= 120% of cost
const STOP_LOSS_NUM = 85n; // value <= 85% of cost
// 200-slot max hold: on the dev window it keeps nearly all of the
// shorter hold's Sharpe edge (150: 0.394, 200: 0.392, 300: 0.383) with a
// better win rate and Sortino than 150.
const MAX_HOLD_SLOTS = 200;

// Orders are filled two slots after they are decided; leave room for the
// price to move in that gap instead of losing the fill to slippage. Fresh
// mints move fast, and a rejected buy on a pumping coin loses the entry
// entirely, so the tolerance is wide.
const MAX_SLIPPAGE_BPS = 1000;

// ------------------------------------------------------------------ per-mint memory

interface MintNotes {
  creator: string | null;
  buyers: Set<string>;
  // SOL the creator spent buying in: their cost basis, the skin in the
  // game. The mark value of the holding inflates as the coin pumps and
  // would wrongly exclude the strongest early flow, so the range check
  // below uses what the creator spent, not what the holding is worth now.
  creatorSpentSol: bigint;
  // Slot of the creator's first sell, if any.
  creatorSellSlot: number | null;
  // True once one of our buys on this mint has filled; a mint is entered
  // once, never re-entered after its exit.
  entered: boolean;
  // Slot the first buy was decided on; the max-hold clock runs from here.
  entrySlot: number | null;
}

const notes = new Map<string, MintNotes>();

function mintNotes(mint: string): MintNotes {
  let n = notes.get(mint);
  if (n === undefined) {
    n = {
      creator: null,
      buyers: new Set<string>(),
      creatorSpentSol: 0n,
      creatorSellSlot: null,
      entered: false,
      entrySlot: null,
    };
    notes.set(mint, n);
  }
  return n;
}

// ------------------------------------------------------------------ helpers

// Current mark value of a holding in lamports, from the curve's virtual
// reserves. Null when the curve cannot price it.
function positionValue(holding: Holding, curve: Curve): bigint | null {
  if (curve.virtual_token_reserves <= 0n) return null;
  return (
    (holding.token_amount * curve.virtual_quote_reserves) /
    curve.virtual_token_reserves
  );
}

function hasPendingBuy(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === 'buy') return true;
  }
  return false;
}

function hasPendingSell(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === 'sell') return true;
  }
  return false;
}

// Fold this batch's events into the per-mint notes: who bought, what the
// creator did, and which of our buys filled.
function noteEvents(state: BotState, batch: Batch): void {
  for (const ev of batch.events) {
    if (ev.event === 'CreateEvent') {
      mintNotes(ev.mint).creator = ev.creator;
      continue;
    }
    if (ev.event !== 'TradeEvent') continue;
    const n = mintNotes(ev.mint);
    if (n.creator === null) n.creator = ev.creator;
    if (ev.is_buy) {
      n.buyers.add(ev.user);
      if (ev.user === ev.creator) {
        n.creatorSpentSol += BigInt(ev.sol_amount);
      }
    } else if (ev.user === ev.creator && n.creatorSellSlot === null) {
      n.creatorSellSlot = ev.slot;
    }
  }
  for (const fill of batch.fills) {
    if (fill.side !== 'buy' || fill.status !== 'filled') continue;
    const n = mintNotes(fill.mint);
    n.entered = true;
    if (n.entrySlot === null) n.entrySlot = fill.decided_slot;
  }
}

// A mint worth buying at all: real early flow, a creator who bought in
// modestly and has not sold. Tier A catches it fresh; Tier B catches the
// same quality a little older, with a smaller probe and the lower trade and
// buyer minimums. The bare age-and-activity read of Tier B lets in hundreds
// of dead coins that lose money, so the quality gate carries over.
function isQualityMint(
  state: BotState,
  mint: string,
  curve: Curve,
  minTrades: number,
  minBuyers: number,
): boolean {
  if (curve.complete || curve.created_slot === null) return false;
  if (
    curve.real_quote_reserves < RESERVE_MIN_SOL ||
    curve.real_quote_reserves > RESERVE_MAX_SOL
  ) {
    return false;
  }
  if (curve.trades < minTrades) return false;
  const n = mintNotes(mint);
  if (n.buyers.size < minBuyers) return false;
  if (n.creatorSellSlot !== null) return false;
  const holding = n.creatorSpentSol;
  return holding >= CREATOR_MIN_SOL && holding <= CREATOR_MAX_SOL;
}

// A mint is a Tier A candidate right now: fresh, with real early flow, a
// creator who bought in modestly and has not sold.
function isTierA(state: BotState, mint: string, curve: Curve): boolean {
  if (curve.created_slot === null) return false;
  const age = state.slot - curve.created_slot;
  if (age > TIER_A_MAX_AGE) return false;
  return isQualityMint(state, mint, curve, TIER_A_MIN_TRADES, TIER_A_MIN_BUYERS);
}

// ------------------------------------------------------------------ strategy

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  noteEvents(state, batch);
  const orders: OrderInput[] = [];
  const maxOpen = state.hello.caps.max_open_positions;
  const txFee = state.txFeeLamports();
  let open = state.committedPositionCount();
  let cashLeft = state.freeCashLamports();

  // --- exits first: a full sell on any trigger. ---
  for (const [mint, holding] of state.positions) {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (hasPendingSell(state, mint)) continue;
    const value = positionValue(holding, curve);
    if (value === null) continue;
    const cost = holding.cost_lamports;
    const n = mintNotes(mint);
    const takeProfit = value * 100n >= cost * TAKE_PROFIT_NUM;
    const stopLoss = value * 100n <= cost * STOP_LOSS_NUM;
    const heldTooLong =
      n.entrySlot !== null && state.slot - n.entrySlot >= MAX_HOLD_SLOTS;
    const creatorSold =
      n.creatorSellSlot !== null &&
      n.entrySlot !== null &&
      n.creatorSellSlot >= n.entrySlot;
    if (takeProfit || stopLoss || heldTooLong || creatorSold) {
      orders.push({
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }
  }

  // --- entries and pyramid adds. ---
  for (const [mint, curve] of state.curves) {
    if (curve.complete || curve.created_slot === null) continue;
    if (state.positions.has(mint) || hasPendingBuy(state, mint)) continue;
    const n = mintNotes(mint);
    if (n.entered) continue;
    const age = state.slot - curve.created_slot;

    if (age <= TIER_A_MAX_AGE) {
      // Tier A: fresh mint. Buy up to 1% of real reserves; the harness caps
      // each reply's buys on one mint at exactly that.
      if (!isTierA(state, mint, curve)) continue;
      if (open >= maxOpen) continue;
      const size = min3(
        state.maxBuyLamports(mint),
        PYRAMID_CAP_SOL,
        cashLeft - txFee,
      );
      if (size < MIN_BUY_SOL) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: size,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      open += 1;
      cashLeft -= size + txFee;
      continue;
    }

    if (age >= TIER_B_MIN_AGE && age <= TIER_B_MAX_AGE) {
      // Tier B: one small probe on the same quality a little older, and
      // never let it take the last open slot.
      if (!isQualityMint(state, mint, curve, TIER_B_MIN_TRADES, TIER_B_MIN_BUYERS)) continue;
      if (open >= maxOpen - 1) continue;
      const size = min3(
        state.maxBuyLamports(mint),
        TIER_B_SIZE_SOL,
        cashLeft - txFee,
      );
      if (size < MIN_BUY_SOL) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: size,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      open += 1;
      cashLeft -= size + txFee;
    }
  }

  // --- pyramid adds on open Tier A positions still inside their window. ---
  for (const [mint, holding] of state.positions) {
    const curve = state.curves.get(mint);
    if (curve === undefined) continue;
    if (curve.created_slot === null) continue;
    if (state.slot - curve.created_slot > PYRAMID_MAX_AGE) continue;
    if (hasPendingBuy(state, mint)) continue;
    if (!isTierA(state, mint, curve)) continue;
    const remaining = PYRAMID_CAP_SOL - holding.cost_lamports;
    if (remaining <= 0n) continue;
    const add = min3(state.maxBuyLamports(mint), remaining, cashLeft - txFee);
    // A dust add pays a transaction fee for a round trip too small to count.
    if (add < MIN_BUY_SOL) continue;
    orders.push({
      side: 'buy',
      mint,
      quote_lamports: add,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    cashLeft -= add + txFee;
  }

  // Never send more orders than one reply may carry; exits were pushed
  // first, so they survive the cut.
  return orders.slice(0, state.hello.caps.max_orders_per_batch);
}

function min3(a: bigint, b: bigint, c: bigint): bigint {
  let m = a < b ? a : b;
  if (c < m) m = c;
  return m;
}

await runBot({ onBatch });
