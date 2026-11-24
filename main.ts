// Entry point for the Pump.fun Bot Sprint (agent-fun/replay/v2).
//
// The harness runs `node main.ts`: the shim in vendor/makefun-bot.ts owns the
// wire (hello / batch / done over stdin/stdout) and hands each batch of
// market events to the strategy in strategy.ts, which returns the orders for
// that slot. Nothing here reads the clock, the environment, or randomness, so
// the two grading executions agree byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

const strategy = createStrategy();

await runBot({
  onHello(state) {
    strategy.onHello(state);
  },
  onBatch(state, batch) {
    // One reply per batch: the orders decided on this slot.
    return strategy.onBatch(state, batch);
  },
  onDone(state) {
    strategy.onDone(state);
  },
});
