# Transaction Latency Measurement

### 1) Introduction 
Using this repo, you can measure transaction latency on differenct blockchain platforms(ex: Solana mainnet-beta, Avalanche C-chain, Polygon PoS, and Klaytn). Transaction latency is measured by sending a simple value transfer transaction through public RPC url provided by each chain. Each subdirectory is for each different blockchain platform. Codes for other chains will be updated.

### 2) Prerequisite
This project uses NodeJS v16.14.2.

### 3) Getting Started
1. Open terminal 
2. Clone the repo by running `https://github.com/klaytn/tx-latency-measurement.git`
3. `cd tx-latency-measurement/{BlockchainName}-tx-latency-measurement` by selecting which blockchain you want to measure.  
4. Copy and paste `.env.template` file. Then rename it to `.env` and update variables with your Private key, url of blockchain explorer, and public rpc url.
6. Run `npm install` to install node packages.
7. Run `node sendtx_{BlockchainName}.js`. 

### 4) List of Blockchain Platforms 
(unchecked: to be updated)
- [x] Klaytn
- [x] Polygon PoS
- [x] Avalanche C-chain 
- [x] Solana
- [x] Near Protocol 
- [x] EOS 
- [x] Fantom
- [x] Polkadot
- [ ] Cosmos
- [x] BNB
- [x] Hedera
- [x] Elrond
- [x] Harmony
