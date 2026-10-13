# Project Map — FabInvests

## Project identity
- Product: FabInvests
- Autonomous agent name: NEXORA
- Mode: paper trading only
- Primary goal: research, simulate, evaluate, and improve strategies using verified market data and virtual capital.

## Planned technology
- Runtime: Node.js, ES modules
- Core engine: JavaScript
- Initial persistence: JSON/JSONL with safe writes and recovery
- Dashboard: Next.js, React, TypeScript, Tailwind CSS, Recharts, Motion
- Dashboard port: 3002

Do not install dependencies or generate the full application until the relevant phase is approved.

## Planned repository layout
The following is the intended layout, not proof that every file already exists:

```text
FabInvests/
├── AGENTS.md
├── README.md
├── PROJECT_MAP.md
├── CURRENT_STATE.md
├── DECISIONS.md
├── TASK_PROTOCOL.md
├── CHANGELOG.md
├── config/
│   └── config.example.json
├── data/
│   ├── market/
│   ├── trades/
│   ├── episodes/
│   ├── strategies/
│   └── world/
├── scripts/
│   ├── lib.mjs
│   └── core/
├── src/
│   ├── persistence/          # Phase 4: local atomic snapshots + recovery (JSON, versioned)
│   ├── accounting/           # Phase 3: in-memory long-only ledger (cash, position, realized/unrealized P&L, fees)
│   ├── execution/            # Phase 3: paper MARKET orders, deterministic fills, idempotent
│   ├── risk/                 # Phase 5: deterministic risk limits + daily realized-loss tracker
│   ├── strategies/           # Phase 6: signal interface + baseline SMA/EMA/RSI (no learning)
│   ├── analytics/            # Phase 7: persistent evaluation records + performance + directional scoring
│   ├── audit/                # Phase 8: JSONL event + equity audit trail + read-only reconciliation
│   ├── episodes/
│   ├── learning/
│   └── world/
├── tests/
└── web/
    └── app/
```

## Path rules
- Always resolve paths from the verified repository root.
- Prefer root-relative paths in documentation.
- Use platform-safe path APIs in code; avoid hard-coded machine-specific absolute paths.
- Keep runtime data under the project `data/` directory unless the user approves otherwise.
- Never write generated files to a parent directory, home directory, or unrelated repository.
- Do not assume the planned layout exists; inspect the filesystem first.

## Core system boundaries
1. Market data: fetch, validate, timestamp, cache, and label data quality.
2. Strategy layer: generate candidate signals only.
3. Risk layer: approve/reject and size simulated positions.
4. Paper execution: simulate fills, fees, slippage, funding, and exits.
5. Accounting: reconcile cash, margin, realized/unrealized P&L, fees, and funding.
6. Learning: evaluate strategies without bypassing risk limits.
7. Dashboard: display persisted engine state; never invent missing values.

## Non-goals
- No real-money trades.
- No exchange order placement.
- No real trading credentials.
- No pretending a simulated fill is a real fill.
