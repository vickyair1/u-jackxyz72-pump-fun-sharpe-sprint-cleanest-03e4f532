# Clean-Flow — Pump.fun Sharpe Sprint

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/vickyair1/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/vickyair1/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Entry for the [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) bounty on [make.fun](https://make.fun).

## Strategy

Clean-Flow is a paper-trading bot for a 6-hour pump.fun replay, ranked by
hourly Sharpe ratio. It catches new coins in their first seconds of life
and rides the early flow with strictly capped holds.

- **Tier A (fresh mints, age ≤ 8 slots):** creator spent 0.15–2.0 SOL buying
  in, real reserves 3–50 SOL, ≥ 4 trades and ≥ 4 buyers, creator has not
  sold. Pyramids up to 2 SOL total, each add capped at 1% of reserves.
- **Tier B (age 9–20 slots):** ≥ 3 trades and ≥ 3 buyers. One 0.1 SOL
  probe, never pyramided, and never allowed to take the last open slot —
  one slot is always kept free for the next Tier A mint.
- **Exits — full sell on any trigger:** take-profit +20%, stop-loss −15%,
  max hold 200 slots, or the creator selling.
- **Guardrails:** max 5 open positions, round trips ≥ 0.01 SOL on ≥ 20
  distinct mints, max drawdown 50%.

## Run

`main.ts` runs on Node 22 as-is, no install and no build step:

```sh
node main.ts
```

It speaks `agent-fun/replay/v2` on stdin/stdout through the kit shim in
`vendor/makefun-bot.ts` and is fully deterministic: no clock, no
environment, no randomness, so two runs decide the same orders.

## Files

- `main.ts` — the strategy.
- `vendor/makefun-bot.ts` — the kit-provided replay shim (not entry code).
- `LICENSE` — MIT.
