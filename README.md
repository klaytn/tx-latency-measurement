# Transaction Latency Measurement

### 1) Introduction 
Using this repo, you can measure transaction latency on differenct blockchain platforms(ex: Solana mainnet-beta, Avalanche C-chain, Polygon PoS, and Klaytn). Transaction latency is measured by sending a simple value transfer transaction through public RPC url provided by each chain. Each subdirectory is for each different blockchain platform. Codes for other chains will be updated.

### 2) Prerequisite
This project uses NodeJS v16.14.2.

### 3) Getting Started
1. Open terminal 
2. Clone the repo by running `https://github.com/klaytn/tx-latency-measurement.git`
3. `cd tx-latency-measurement/{BlockchainName}-tx-latency-measurement` by selecting which blockchain you want to measure.  
4. Run `npm install` to install node packages.
5. Copy and paste `.env.template` file. Then rename it to `.env` and update variables with your Private key, url of blockchain explorer, and public rpc url. 
You should also decide whethere to upload to GCS/S3, and provide appropriate credentials.
6. Run `node sendtx_{BlockchainName}.js`. 

### 4) Simple Test with Testnet (Klaytn) 
1. Open terminal 
2. Clone the repo by running `https://github.com/klaytn/tx-latency-measurement.git`
3. Run `npm install` to install node packages. 
```
cd tx-latency-measurement/klaytn-tx-latency-measurement
npm install
```
3. Copy and paste `.env.template` file. Then rename it to `.env`. 
```shell
cp .env.template .env
```
4. Update `.env` and make sure PRIVATE_KEY and S3_BUCKET is empty as below: 
```
PRIVATE_KEY=
CAVER_URL=https://public-node-api.klaytnapi.com/v1/baobab
S3_BUCKET=
```
5. Run `node sendtx_klaytn.js`. Then the output will give you new Private Key and Address. 
```shell
starting tx latency measurement... start time = 1661338618926
Private key is not defined. Use this new private key({NEW_PRIVATE_KEY}).
Get test KLAY from the faucet: https://baobab.wallet.klaytn.foundation/faucet
Your Klaytn address = {NEW_ADDRESS}
```
-   With `NEW_ADDRESS`, get test KLAY from faucet page.
-  Update PRIVATE_KEY in .env file with this `NEW_PRIVATE_KEY`. 
6. Run `node sendtx_klaytn.js`. You can see the result as below:
```
starting tx latency measurement... start time = 1661339036754
failed to s3.upload! Printing instead! undefined bucket name
{"executedAt":1661339056756,"txhash":"0x78273bf3015cffc003b09908b322562eda5d830b455ae1c80b7a090d3b60a43b","startTime":1661339057100,"endTime":1661339059192,"chainId":1001,"latency":2092,"error":"","txFee":0.00105,"txFeeInUSD":0.00026812274999999996,"resourceUsedOfLatestBlock":38800,"numOfTxInLatestBlock":1,"pingTime":24}
```

### 5) Running in Docker

1. Install Docker https://docs.docker.com/install/

2. Build a docker image in a folder you would like to measure.
    ```bash
    > docker build -t klaytn-tx-latency-measurement:latest .
    ```

3. Run a container out of the image
    ```bash
    > docker run klaytn-tx-latency-measurement:latest
    ```

*Note: You need to provide credentials JSON inside a directory if you wish to upload to GCS*

### 6) List of Blockchain Platforms 
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
