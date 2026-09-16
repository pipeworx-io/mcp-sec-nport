# @pipeworx/sec-nport

Mutual fund and ETF portfolio holdings, from SEC Form N-PORT. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Tools

- `nport_fund_owners(security, quarter?, limit?)` — which funds and ETFs hold a stock or bond, ranked by position size. Takes a ticker, a company name, or a CUSIP.
- `nport_fund_portfolio(fund, quarter?, limit?)` — one fund's reported positions, largest first.
- `nport_holdings_coverage()` — which releases are loaded, how current they are, and what the data does not cover.

## The inversion is the point of this pack

"Which ETFs hold the largest positions in NVDA?" returned **no_match** before this shipped, and the
router explained the gap in its own words: it would have to check each ETF individually.
`edgar_fund_holdings` goes fund → holdings. Nothing went security → funds, because SEC publishes
N-PORT filing-first and so does every API over it. That is a shape problem, not a rate-limit problem.

This is not 13F warmed over. 13F is institutional **managers** over $100M, long US equity only.
N-PORT is registered **funds** — mutual funds and ETFs — and carries their **bond** positions too.
"Which funds hold this corporate bond" has no 13F answer at all.

## Scope, stated because a partial load read as a complete one is a wrong answer

The quarterly archive is 441MB across 32 tables. Loaded: equity, preferred and debt positions —
about 3.6M of the 5.35M holdings rows per quarter, across 14,416 funds. **Not loaded:** derivatives,
loans, repos and structured products. A swap notional is not a holding of the underlying, and
reporting it as one would be a wrong answer wearing a right one's clothes. Every response carries
this in its `scope` field.

Two more caveats ride on every answer:

- **N-PORT is filed monthly but released publicly on a quarterly lag**, roughly 60 days after the
  quarter ends. Responses carry `as_of_period`. An answer that implies real-time is wrong.
- **N-PORT has no ETF flag.** These are registered funds, which include ETFs and mutual funds alike;
  the series name is the only hint. An ETF-only answer cannot be given honestly from this filing, so
  the pack says that rather than inventing the classification.

## Where the data lives, and why it is not in R2

**All of it is in Postgres.** Measured on the live database, one release loaded:

| table | rows | on disk |
|---|---|---|
| `sec_nport_holdings` | 3,614,371 | **1,123 MB** |
| `sec_nport_funds` | 14,416 | 8.9 MB |

That is a real amount of Postgres for one pack, so the choice is worth stating rather than
leaving for someone to rediscover at 3am.

**The query is the reason.** The inversion this pack exists for — *which funds hold this
security* — is a selective lookup on `cusip` and `issuer_name` returning tens of rows out of
3.6M. That is precisely what a B-tree index is for: it answers in milliseconds and touches
almost none of the 1.1GB. R2 has no indexes. Serving the same question from object storage
means either scanning the objects or building a side index to point into them, which is a
worse database than the one already here.

R2 earns its place when the access pattern is *bulk*: whole-file reads, archival quarters
nobody queries interactively, or payloads too large to index usefully. A reasonable split
later is **hot quarters in Postgres, cold quarters in R2** — but that only pays once several
quarters are loaded, and today exactly one is. Splitting now would add a storage tier to save
nothing.

**Where the line is, so the next person does not have to guess.** Each quarter costs roughly
1.1GB. Around four to six loaded quarters this becomes the largest single consumer in the
database and the cold-quarter split should be built rather than discussed. `sec_13f_holdings`
sits at 3.8M rows for comparison — this pack is the same order of magnitude, not a new class
of problem.

## Ticker resolution

The holdings table keys on CUSIP, which is proprietary to CUSIP Global Services, so this pack does
**not** build or cache a bulk CUSIP↔ticker table. A ticker-shaped input resolves live through
**OpenFIGI** (Bloomberg FIGI, openly licensed) to a canonical company name, which is then matched
against `issuer_name` in our own already-ingested rows — preferring the candidate that is not an
ETF or option wrapper, because "NVDA" otherwise matches *Direxion Daily NVDA Bull 2X* right
alongside NVIDIA and ranks them together. Same discipline as the 13F pack, deliberately.

## Source

SEC Form N-PORT data sets — https://www.sec.gov/data-research/sec-markets-data/form-n-port-data-sets

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "sec-nport": {
      "url": "https://gateway.pipeworx.io/sec-nport/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/sec-nport/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "sec-nport": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-sec-nport"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-sec-nport
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Sec Nport data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
