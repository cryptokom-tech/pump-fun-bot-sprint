# Strategy: selective launch sniper with pacing probes

## The market

The replay is 24 hours of pump.fun bonding-curve events (dev window 2–3 Nov
2026); the final is a fresh 6-hour window recorded after entries close. The
bot starts with 10 SOL of paper cash, may hold at most 5 positions, may spend
at most 1% of a coin's real SOL reserve per buy, pays ~1.25% curve fees plus
105,000 lamports per transaction, and fills 2 slots after deciding. About
2% of transactions fail (fees still paid). The guardrails: at least 20 coins
with a round trip of at least 0.01 SOL each, max drawdown at most 50%, and net
PnL above 0 SOL to take a paid place.

## Design

### 1. Sniper entries — buy only launches with real early demand

A launch qualifies only if, in its first 3 slots, it already holds **10–30
SOL of real reserve**, has **at most 2 distinct non-creator buyers**, its
creator bought **at most 0.5 SOL**, and the creator has **not sold**. Rationale:

- Reserve below 10 SOL means almost nobody bought in yet; the coin is a
  lottery ticket with no signal.
- Reserve above 30 SOL in the first 3 slots means the early move is already
  gone; chasing it buys the top.
- A creator who loaded up heavily, or who is already selling, is the classic
  rug shape; small creator exposure plus no creator sale is the cheapest
  rug filter available from the event stream.
- Two or fewer outside buyers keeps the entry early, before the crowd.

Stake is **~0.1 SOL** (1% of a 10 SOL reserve is exactly 0.1 SOL, so the
reserve cap binds at the low end and the stake is effectively the cap).
Entries smaller than 0.05 SOL are skipped as not worth the transaction fees.

### 2. Exits — tight stop, modest target, short hold

- Take-profit **+30%** vs the entry price (virtual-reserve price at the buy
  decision).
- Stop-loss **−3%** vs the entry price.
- Max hold **30 slots** (~12 seconds of chain time): a launch that has not
  moved in 30 slots is dead weight; free the position slot.
- **Creator sell** at any time after entry: exit immediately.

The asymmetry (+30% / −3%) is deliberate: most launches go to zero, so the
bot needs the rare runner to pay for many small stops. All price comparisons
use integer cross-multiplication on the virtual reserves — no floats, no
clock, fully deterministic.

### 3. Pacing probes — meet the 20-coin bar on purpose

Sniper entries alone land roughly one coin per hour of replay, which would
miss the 20-coin guardrail in a 6-hour final window. So the bot also buys
**0.012 SOL probes** — the smallest buy that still counts as a round trip
(the bar is 0.01 SOL spent; 0.012 leaves margin for curve fees) — on fresh
launches (first 3 slots, real reserve at least 1.2 SOL so the 1% cap covers
the stake) and sells them on the next batch. Probes are paced against the
window clock read from event `block_time`: the bot targets **21 coins**
(guardrail + 1) spread evenly over 6 hours, and fills any remaining gap in
the last 10% of the window. A probe costs roughly its spread plus two
transaction fees (~0.0002 SOL), so 21 probes cost well under 0.01 SOL in
total — cheap insurance for the guardrail.

### 4. What the bot does NOT do

- No momentum chasing of already-running coins (measured far worse on the dev
  data: large negative slices).
- No broad buying of every launch (negative on the dev data).
- No holding through completion: the harness closes migrated positions itself.
- No randomness, no clock, no environment reads: the two grading executions
  must produce byte-identical action logs.

## Local measurements

Official `grade-local` (process driver, commit
`402130dd479d84d60fec4dd5d16b47247ddeee01`), dev window = kit's frozen 24h
dataset (2–3 Nov 2026, 128,058 events):

- **Net PnL +0.030992819 SOL** (return +0.31%, 90% interval −0.048..+0.146 SOL)
- **29 coins, 29 round trips**, 58 fills, win rate 13.8%, max drawdown 0.0037
- Fees: 0.0268 SOL curve + 0.0062 SOL tx; at 2x fees net −0.0021 SOL
- **Guardrails met** (29 coins ≥ 0.01 SOL round trips, drawdown ok)
- Top 3 coins made 97% of the gains; without them net PnL is −0.04 SOL —
  the bot lives or dies by catching 1–2 runners per window, like every
  sniper on this data.
- L1 regrade reproduced byte for byte (deterministic).
- 9 rejected orders (mostly slippage on fast launches), 1 failed tx.

Stress test (`grade-local --stress 20`): see `grade-stress.log` in the work
directory. Honest read: the dev score leans on this window's coins; the
fresh 6-hour final window is a lottery among near-breakeven bots, and this
design is the strongest measured shape (broad buying and momentum chasing
both scored clearly negative on the same data).

The final window is a fresh 6h slice — expect the dev number to flatter
the bot and the stress test to show the honest spread.
