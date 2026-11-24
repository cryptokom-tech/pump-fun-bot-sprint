// Selective launch sniper for the Pump.fun Bot Sprint (agent-fun/replay/v2).
//
// Idea: most pump.fun launches die fast, but a small slice shows real early
// demand — several SOL of genuine reserve built in the first few slots, a
// creator who barely bought in, and no creator dump. The bot buys only those
// launches, small (about 0.1 SOL, capped at 1% of the real reserve), and exits
// on a tight stop, a modest take-profit, a short max hold, or any creator
// sell. Separately, cheap 0.012 SOL probe round trips pace the bot to the
// 20-coin minimum bar over the 6-hour final window, so the guardrail is met
// even in a quiet window.
//
// Everything is deterministic: no clock, no environment, no randomness. Time
// is read only from the replay itself (event block_time, falling back to slot
// count), so the two grading executions produce byte-identical action logs.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

export const LAMPORTS_PER_SOL = 1_000_000_000n;

// --- tuned constants (see STRATEGY.md for why each value was chosen) ---
const ENTRY_MIN_REAL_SOL = 10n; // entry needs >= 10 SOL of real reserve
const ENTRY_MAX_REAL_SOL = 30n; // ... and at most 30 SOL (past that the easy move is gone)
const ENTRY_MAX_AGE_SLOTS = 3; // only launches in their first 3 slots
const ENTRY_MAX_BUYERS = 2; // at most 2 distinct non-creator buyers so far
const CREATOR_BUY_CAP_LAMPORTS = 500_000_000n; // creator bought at most 0.5 SOL
const SNIPER_STAKE_LAMPORTS = 100_000_000n; // ~0.1 SOL per sniper entry
const SNIPER_MIN_STAKE_LAMPORTS = 50_000_000n; // skip entries smaller than 0.05 SOL
const TAKE_PROFIT_NUM = 130n; // sell at +30% vs the entry price
const TAKE_PROFIT_DEN = 100n;
const STOP_LOSS_NUM = 97n; // sell at -3% vs the entry price
const STOP_LOSS_DEN = 100n;
const MAX_HOLD_SLOTS = 30; // never hold a sniper entry longer than 30 slots
const PROBE_STAKE_LAMPORTS = 12_000_000n; // 0.012 SOL: smallest probe that still counts
const PROBE_MIN_REAL_LAMPORTS = 1_200_000_000n; // probe needs real reserve >= 1.2 SOL (1% cap >= stake)
const PROBE_MAX_AGE_SLOTS = 3; // probes only touch launches in their first 3 slots
const PROBES_PER_BATCH = 2; // at most 2 probe buys per batch
const TARGET_COINS = 21; // guardrail is 20; aim one above it
const FINAL_WINDOW_SECONDS = 21_600; // 6 hours
const FINAL_PUSH_AFTER_SECONDS = 19_440; // last 10% of the window: fill the gap at once
const MAX_SLIPPAGE_BPS = 500;

type Kind = 'sniper' | 'probe';

interface CoinInfo {
  mint: string;
  createdSlot: number | null;
  creator: string | null;
  creatorBuyLamports: bigint;
  creatorSold: boolean;
  buyers: Set<string>;
  buySent: boolean;
  buyFilled: boolean;
  sold: boolean;
  kind: Kind | null;
  entryQ: bigint; // virtual quote reserves at the buy decision (entry price numerator)
  entryT: bigint; // virtual token reserves at the buy decision (entry price denominator)
  entrySlot: number;
}

/** Price comparison without floats: is curQ/curT >= entQ/entT * num/den ? */
function priceAtLeast(
  curQ: bigint, curT: bigint,
  entQ: bigint, entT: bigint,
  num: bigint, den: bigint,
): boolean {
  if (curT === 0n || entT === 0n) return false;
  return curQ * entT * num >= entQ * curT * den;
}

/** Price comparison without floats: is curQ/curT <= entQ/entT * num/den ? */
function priceAtMost(
  curQ: bigint, curT: bigint,
  entQ: bigint, entT: bigint,
  num: bigint, den: bigint,
): boolean {
  if (curT === 0n || entT === 0n) return true;
  return curQ * entT * num <= entQ * curT * den;
}

export function createStrategy() {
  const coins = new Map<string, CoinInfo>();
  let windowStartSec: number | null = null;
  let lastSlot = -1;
  let lastSec: number | null = null;

  function infoFor(mint: string, slot: number): CoinInfo {
    let info = coins.get(mint);
    if (info === undefined) {
      info = {
        mint,
        createdSlot: null,
        creator: null,
        creatorBuyLamports: 0n,
        creatorSold: false,
        buyers: new Set<string>(),
        buySent: false,
        buyFilled: false,
        sold: false,
        kind: null,
        entryQ: 0n,
        entryT: 0n,
        entrySlot: slot,
      };
      coins.set(mint, info);
    }
    return info;
  }

  /** Fold this batch's events into the per-coin tracking. */
  function trackEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const info = infoFor(e.mint, e.slot);
        if (info.createdSlot === null) info.createdSlot = e.slot;
        info.creator = e.creator;
      } else if (e.event === 'TradeEvent') {
        const info = infoFor(e.mint, e.slot);
        if (info.createdSlot === null) info.createdSlot = e.slot;
        if (info.creator === null) info.creator = e.creator;
        const amount = BigInt(e.sol_amount);
        if (e.user === info.creator) {
          if (e.is_buy) info.creatorBuyLamports += amount;
          else info.creatorSold = true;
        } else if (e.is_buy) {
          info.buyers.add(e.user);
        }
      } else {
        // CompleteEvent: the curve migrated; nothing more to track.
        const info = coins.get(e.mint);
        if (info !== undefined) info.sold = true;
      }
    }
  }

  /** Fold this batch's fills into the per-coin tracking. */
  function trackFills(batch: Batch): void {
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        // A harness close (complete / flatten / writeoff) ends the position.
        const info = coins.get(f.mint);
        if (info !== undefined && f.side === 'sell' && f.status === 'filled') info.sold = true;
        continue;
      }
      const info = coins.get(f.mint);
      if (info === undefined) continue;
      if (f.side === 'buy') {
        if (f.status === 'filled') info.buyFilled = true;
        else if (f.status === 'rejected' || f.status === 'failed') info.buySent = false;
      } else if (f.side === 'sell' && f.status === 'filled') {
        info.sold = true;
      }
    }
  }

  /** Seconds elapsed in the replay window, from event block_time (slot fallback). */
  function elapsedSeconds(batch: Batch): number {
    let sec: number | null = null;
    for (const e of batch.events) {
      if (e.block_time !== null && e.block_time !== undefined) sec = e.block_time;
    }
    if (sec === null) {
      if (windowStartSec === null || lastSec === null) return 0;
      // Solana slots run about 0.4s; keep it integral and deterministic.
      return lastSec + Math.floor(((batch.slot - lastSlot) * 2) / 5) - windowStartSec;
    }
    if (windowStartSec === null) windowStartSec = sec;
    lastSec = sec;
    lastSlot = batch.slot;
    return sec - windowStartSec;
  }

  /** Distinct mints with a filled buy (a round trip in progress or done). */
  function coveredCount(): number {
    let n = 0;
    for (const info of coins.values()) if (info.buyFilled) n++;
    return n;
  }

  function hasPendingBuy(state: BotState, mint: string): boolean {
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy' && p.order.mint === mint) return true;
    }
    return false;
  }

  /** A sell already sent for this mint and not yet resolved: do not send another. */
  function hasPendingSell(state: BotState, mint: string): boolean {
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell' && p.order.mint === mint) return true;
    }
    return false;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    trackEvents(batch);
    trackFills(batch);
    const elapsed = elapsedSeconds(batch);
    const slot = batch.slot;

    // --- exits first: free positions before deciding new entries ---
    for (const [mint, holding] of state.positions) {
      if (hasPendingSell(state, mint)) continue; // sell already in flight; it fills 2 slots later
      const info = coins.get(mint);
      if (info === undefined || info.kind === null) {
        // A position we cannot explain: sell it rather than hold it blind.
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
        continue;
      }
      if (info.kind === 'probe') {
        // Probes exist only to count the coin: exit on the first batch after the fill.
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
        info.sold = true;
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue; // harness closes it
      const hitTp = priceAtLeast(
        curve.virtual_quote_reserves, curve.virtual_token_reserves,
        info.entryQ, info.entryT, TAKE_PROFIT_NUM, TAKE_PROFIT_DEN,
      );
      const hitSl = priceAtMost(
        curve.virtual_quote_reserves, curve.virtual_token_reserves,
        info.entryQ, info.entryT, STOP_LOSS_NUM, STOP_LOSS_DEN,
      );
      const tooOld = slot - info.entrySlot >= MAX_HOLD_SLOTS;
      if (hitTp || hitSl || tooOld || info.creatorSold) {
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
        info.sold = true;
      }
    }

    // --- sniper entries: fresh launches with real early demand ---
    const maxPositions = state.hello.caps.max_open_positions;
    for (const [mint, curve] of state.curves) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= maxPositions) break;
      const info = coins.get(mint);
      if (info === undefined || curve.complete) continue;
      if (info.buySent || info.buyFilled || info.sold) continue;
      if (info.createdSlot === null) continue;
      const age = slot - info.createdSlot;
      if (age < 0 || age > ENTRY_MAX_AGE_SLOTS) continue;
      const realSol = curve.real_quote_reserves;
      if (realSol < ENTRY_MIN_REAL_SOL * LAMPORTS_PER_SOL) continue;
      if (realSol > ENTRY_MAX_REAL_SOL * LAMPORTS_PER_SOL) continue;
      if (info.buyers.size > ENTRY_MAX_BUYERS) continue;
      if (info.creatorBuyLamports > CREATOR_BUY_CAP_LAMPORTS) continue;
      if (info.creatorSold) continue;
      if (hasPendingBuy(state, mint)) continue;
      const cap = state.maxBuyLamports(mint);
      const stake = cap < SNIPER_STAKE_LAMPORTS ? cap : SNIPER_STAKE_LAMPORTS;
      if (stake < SNIPER_MIN_STAKE_LAMPORTS) continue;
      if (state.freeCashLamports() < stake + state.txFeeLamports()) continue;
      orders.push({ side: 'buy', mint, quote_lamports: stake, max_slippage_bps: MAX_SLIPPAGE_BPS });
      info.buySent = true;
      info.kind = 'sniper';
      info.entryQ = curve.virtual_quote_reserves;
      info.entryT = curve.virtual_token_reserves;
      info.entrySlot = slot;
    }

    // --- pacing probes: stay on track for the 20-coin minimum bar ---
    const covered = coveredCount();
    const desired =
      elapsed >= FINAL_PUSH_AFTER_SECONDS
        ? TARGET_COINS
        : Math.floor((TARGET_COINS * elapsed) / FINAL_WINDOW_SECONDS);
    if (covered < desired) {
      let probes = 0;
      for (const [mint, curve] of state.curves) {
        if (probes >= PROBES_PER_BATCH) break;
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= maxPositions) break;
        const info = coins.get(mint);
        if (info === undefined || curve.complete) continue;
        if (info.buySent || info.buyFilled || info.sold) continue;
        if (info.createdSlot === null) continue;
        const age = slot - info.createdSlot;
        if (age < 0 || age > PROBE_MAX_AGE_SLOTS) continue;
        if (curve.real_quote_reserves < PROBE_MIN_REAL_LAMPORTS) continue;
        if (state.maxBuyLamports(mint) < PROBE_STAKE_LAMPORTS) continue;
        if (hasPendingBuy(state, mint)) continue;
        if (state.freeCashLamports() < PROBE_STAKE_LAMPORTS + state.txFeeLamports()) continue;
        orders.push({ side: 'buy', mint, quote_lamports: PROBE_STAKE_LAMPORTS, max_slippage_bps: MAX_SLIPPAGE_BPS });
        info.buySent = true;
        info.kind = 'probe';
        info.entryQ = curve.virtual_quote_reserves;
        info.entryT = curve.virtual_token_reserves;
        info.entrySlot = slot;
        probes++;
      }
    }

    return orders;
  }

  return {
    onHello(_state: BotState): void {
      // Nothing to seed: hello carries the capital and caps, the strategy
      // reads the window clock from the first batch of events instead.
    },
    onBatch,
    onDone(_state: BotState): void {
      // The harness flattens positions at the end; nothing left to do.
    },
  };
}
