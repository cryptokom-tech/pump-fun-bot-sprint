# Pump.fun Bot Sprint — Selective Launch Sniper

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/cryptokom-tech/pump-fun-bot-sprint/rank.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/cryptokom-tech/pump-fun-bot-sprint/reward.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Entry for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
bounty on [make.fun](https://make.fun). The bot paper-trades SOL on a replay
of pump.fun bonding-curve chain data — no real funds, no entry fee.

## Strategy (one paragraph)

Most pump.fun launches die fast. The bot buys only launches that already show
real early demand in their first 3 slots: 10–30 SOL of real reserve, at most 2
distinct non-creator buyers, a creator who bought at most 0.5 SOL, and no
creator sale. Stake is about 0.1 SOL per launch (capped at 1% of the real
reserve). Exits: take-profit +30%, stop-loss −3%, max hold 30 slots, or any
creator sell. Separately, cheap 0.012 SOL probe round trips pace the bot to 21
coins over the 6-hour final window so the 20-coin minimum bar is met even in a
quiet window. Full design, parameters, and measurements: [STRATEGY.md](STRATEGY.md).

## Layout

- `main.ts` — entry point; hands each batch of market events to the strategy.
- `strategy.ts` — the strategy (entry filter, exits, probe pacing).
- `vendor/makefun-bot.ts` — the kit's replay-protocol shim (copied from the kit).
- `STRATEGY.md` — design notes and local grade results.

## Grade locally

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path to this repo> --driver process
```

## License

MIT — see [LICENSE](LICENSE).
