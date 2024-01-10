# Go FinalityScraper

Web Scraper to determine finality & latency between L2 & L1 blockchains, implemented in [Golang][Go]

## Prerequisites

- [Go][Go]
- [Docker][Docker]

## Installation

Clone

```sh
cp .env.example .env
```

Develop

```sh
go run .
```

Build & Run

```sh
go build && ./go-finalityscraper
```

Docker

```sh
docker build -t go-finalityscraper .
docker run go-finalityscraper -p 8080:8080 # <PORT in .env> : <Port on host>
```

## Features

### Server Mode (.env MODE=server)

**Root End Timestamp** (`/root_end?from_chain=<chain_id>&hash=0x...`)\
returns { "root_end": "<unix timestamp>" }\
e.g. { "root_end": "0" }

#### Implemented Chains

| From Chain                                    | --> To Chain                              |
|-----------------------------------------------|-------------------------------------------|
| [Optimism][Optimism] (`10`)                   | [Ethereum][Ethereum] (`1`)                |
| [Arbitrum][Arbitrum] (`42161`)                | [Ethereum][Ethereum] (`1`)                |
| [Optimism Goerli][Optimism Goerli] (`420`)    | [Ethereum Goerli][Ethereum Goerli]  (`5`) |
| [Arbitrum Goerli][Arbitrum Goerli] (`421613`) | [Ethereum Goerli][Ethereum Goerli]  (`5`) |

### Scan Mode (.env MODE=scan)

Iterates through a list of pages (.env SCAN_PAGES) on [Optimism Explorer][Optimism] to estimate mean & max L2->L1 latency

- 10 transactions per page
- Results saved in `data.csv`

[Go]: <https://golang.org/doc/install>
[Docker]: <https://www.docker.com>

[Ethereum]: <https://etherscan.io>
[Ethereum Goerli]: <https://goerli.etherscan.io>
[Arbitrum]: <https://arbiscan.io>
[Arbitrum Goerli]: <https://goerli.arbiscan.io>
[Optimism]: <https://optimistic.etherscan.io>
[Optimism Goerli]: <https://goerli-optimism.etherscan.io>
