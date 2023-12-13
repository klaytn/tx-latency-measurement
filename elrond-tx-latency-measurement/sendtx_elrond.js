// Elrond transaction latency measurement.
// API reference: https://api.elrond.com/
// Reference for signing transaction: https://github.com/ElrondNetwork/elrond-sdk-erdjs/blob/a9b33e90ba7df70e11898cc0b8149966a0a61f29/src/transaction.local.net.spec.ts

const { ApiNetworkProvider } = require("@elrondnetwork/erdjs-network-providers");
const { TokenPayment, TransactionWatcher } = require("@elrondnetwork/erdjs/out");
const { Transaction, Address } = require("@elrondnetwork/erdjs");
const { UserSigner, UserSecretKey } = require("@elrondnetwork/erdjs-walletcore");
const core = require("@elrondnetwork/elrond-core-js");
const fs = require("fs");
const AWS = require("aws-sdk");
const parquet = require("parquetjs-lite");
const moment = require("moment");
const axios = require("axios");
const CoinGecko = require("coingecko-api");
const CoinGeckoClient = new CoinGecko();
const { Storage } = require("@google-cloud/storage");
require("dotenv").config();

const networkProvider = new ApiNetworkProvider(process.env.PUBLIC_API_URL, { timeout: 5000 });
var signer;

async function makeParquetFile(data) {
  var schema = new parquet.ParquetSchema({
    executedAt: { type: "TIMESTAMP_MILLIS" },
    txhash: { type: "UTF8" },
    startTime: { type: "TIMESTAMP_MILLIS" },
    endTime: { type: "TIMESTAMP_MILLIS" },
    chainId: { type: "INT64" },
    latency: { type: "INT64" },
    error: { type: "UTF8" },
    txFee: { type: "DOUBLE" },
    txFeeInUSD: { type: "DOUBLE" },
    resourceUsedOfLatestBlock: { type: "INT64" },
    numOfTxInLatestBlock: { type: "INT64" },
    pingTime: { type: "INT64" },
  });

  var d = new Date();
  //20220101_032921
  var datestring = moment().format("YYYYMMDD_HHmmss");

  var filename = `${datestring}_${data.chainId}.parquet`;

  // create new ParquetWriter that writes to 'filename'
  var writer = await parquet.ParquetWriter.openFile(schema, filename);

  await writer.appendRow(data);

  await writer.close();

  return filename;
}

async function sendSlackMsg(msg) {
  axios.post(
    process.env.SLACK_API_URL,
    {
      channel: process.env.SLACK_CHANNEL,
      mrkdown: true,
      text: msg,
    },
    {
      headers: {
        "Content-type": "application/json",
        "Authorization": `Bearer ${process.env.SLACK_AUTH}`,
      },
    }
  );
}

async function uploadToS3(data) {
  if (process.env.S3_BUCKET === "") {
    throw "undefined bucket name";
  }

  const s3 = new AWS.S3();
  const filename = await makeParquetFile(data);
  const param = {
    Bucket: process.env.S3_BUCKET,
    Key: filename,
    Body: fs.createReadStream(filename),
    ContentType: "application/octet-stream",
  };
  await s3.upload(param).promise();

  fs.unlinkSync(filename);
}

async function uploadToGCS(data) {
  if (
    process.env.GCP_PROJECT_ID === "" ||
    process.env.GCP_KEY_FILE_PATH === "" ||
    process.env.GCP_BUCKET === ""
  ) {
    throw "undefined parameters";
  }

  const storage = new Storage({
    projectId: process.env.GCP_PROJECT_ID,
    keyFilename: process.env.GCP_KEY_FILE_PATH,
  });

  const filename = await makeParquetFile(data);
  const destFileName = `tx-latency-measurement/elrond/${filename}`;

  async function uploadFile() {
    const options = {
      destination: destFileName,
    };

    await storage.bucket(process.env.GCP_BUCKET).upload(filename, options);
    console.log(`${filename} uploaded to ${process.env.GCP_BUCKET}`);
  }

  await uploadFile().catch(console.error);
  fs.unlinkSync(filename);
}

async function uploadChoice(data) {
  if (process.env.UPLOAD_METHOD === "AWS") {
    await uploadToS3(data);
  } else if (process.env.UPLOAD_METHOD === "GCP") {
    await uploadToGCS(data);
  } else {
    throw "Improper upload method";
  }
}

async function sendTx() {
  var data = {
    executedAt: new Date().getTime(),
    txhash: "",
    startTime: 0,
    endTime: 0,
    chainId: process.env.CHAIN_ID,
    latency: 0,
    error: "",
    txFee: 0.0,
    txFeeInUSD: 0.0,
    resourceUsedOfLatestBlock: 0,
    numOfTxInLatestBlock: 0,
    pingTime: 0,
  };

  try {
    const address = signer.getAddress();

    const account = await networkProvider.getAccount(address);
    const balance = account.balance.toNumber() * 10 ** -18;

    if (balance < parseFloat(process.env.BALANCE_ALERT_CONDITION_IN_EGLD)) {
      sendSlackMsg(
        `Current balance of <${
          process.env.SCOPE_URL
        }/accounts/${address.toString()}|${address.toString()}> is less than ${
          process.env.BALANCE_ALERT_CONDITION_IN_EGLD
        } EGLD! balance=${balance} EGLD`
      );
    }

    const networkConfig = await networkProvider.getNetworkConfig();

    const startGetBlock = new Date().getTime();
    const networkStatus = await networkProvider.getNetworkStatus();
    const endGetBlock = new Date().getTime();
    data.pingTime = endGetBlock - startGetBlock;

    // blocks from different shard(currently 3 shards) are included in metachain block (hyperblock)
    var gasUsed = 0.0;
    var txCount = 0;
    const metachainShardId = 4294967295;
    let response = await axios.get(
      process.env.PUBLIC_API_URL +
        `/blocks?nonce=${networkStatus.HighestFinalNonce}&shard=${metachainShardId}`,
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    //Calc reference: https://explorer.elrond.com/blocks/562f5a24b79f2b383881c1e42f2759d90ad47458187c4af92e03af8d45fcad49
    gasUsed +=
      response.data[0].gasConsumed - response.data[0].gasRefunded - response.data[0].gasPenalized;
    txCount += response.data[0].txCount;

    let hyperblockInfo = await axios.get(
      process.env.PUBLIC_API_URL + `/blocks/${response.data[0].hash}`,
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    for await (blockhash of hyperblockInfo.data.notarizedBlocksHashes) {
      let shardBlockInfo = await axios.get(process.env.PUBLIC_API_URL + `/blocks/${blockhash}`, {
        headers: {
          "Content-Type": "application/json",
        },
      });
      gasUsed +=
        Number(shardBlockInfo.data.gasConsumed) -
        Number(shardBlockInfo.data.gasRefunded) -
        Number(shardBlockInfo.data.gasPenalized);
      txCount += shardBlockInfo.data.txCount;
    }
    data.resourceUsedOfLatestBlock = gasUsed;
    data.numOfTxInLatestBlock = txCount;

    // Create Transaction
    let tx = new Transaction({
      sender: address,
      receiver: address,
      gasLimit: 50000,
      value: TokenPayment.egldFromAmount(0),
      chainID: networkConfig.ChainID,
      nonce: account.nonce,
    });

    // Sign Transaction
    await signer.sign(tx);

    let watcher = new TransactionWatcher(networkProvider);
    const start = new Date().getTime();
    data.startTime = start;
    const txHash = await networkProvider.sendTransaction(tx);

    // Wait for transaction completion (Ref: https://docs.elrond.com/sdk-and-tools/erdjs/erdjs-cookbook/)
    await watcher.awaitCompleted(tx);
    const end = new Date().getTime();
    data.endTime = end;
    data.latency = end - start;
    data.txhash = txHash;

    // Get gasPrice and gasUsed of transaction
    let txDetails = await axios.get(process.env.PUBLIC_API_URL + `/transactions/${txHash}`, {
      headers: {
        "Content-Type": "application/json",
      },
    });
    data.txFee = txDetails.data.gasPrice * txDetails.data.gasUsed * 10 ** -18;

    // Calculate Transaction Fee and Get Tx Fee in USD
    var EGLDtoUSD;
    await CoinGeckoClient.simple
      .price({
        ids: ["elrond-erd-2"],
        vs_currencies: ["usd"],
      })
      .then((response) => {
        EGLDtoUSD = response.data["elrond-erd-2"]["usd"];
      });
    data.txFeeInUSD = data.txFee * EGLDtoUSD;
    // console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
  } catch (err) {
    sendSlackMsg(`Failed to execute, ${err.toString()}`);
    console.log("failed to execute.", err.toString());
    data.error = err.toString();
    // console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
  }
  try {
    await uploadToS3(data);
  } catch (err) {
    console.log("failed to s3.upload! Printing instead!", err.toString());
    console.log(JSON.stringify(data));
  }
}

async function main() {
  const start = new Date().getTime();
  console.log(`starting tx latency measurement... start time = ${start}`);

  if (process.env.SIGNER_SECRET_KEY === "") {
    let account = new core.account();
    let mnemonic = account.generateMnemonic();
    let privateKeyHex = account.privateKeyFromMnemonic(mnemonic, false, "0", "");
    let privateKey = Buffer.from(privateKeyHex, "hex");
    account.generateKeyFileFromPrivateKey(privateKey, "password");
    const address = new UserSigner(UserSecretKey.fromString(privateKeyHex)).getAddress().bech32();
    console.log(`Private Key is not defined. Use this new private key (${privateKeyHex})`);
    console.log(`Get test dEGLD from the faucet: https://r3d4.fr/faucet`);
    console.log(`Your Elrond address = ${address}`);
    console.log(
      `OR you can create wallet account from Devnet Wallet: https://devnet-wallet.elrond.com/`
    );
    return;
  }

  signer = new UserSigner(UserSecretKey.fromString(process.env.SIGNER_SECRET_KEY));

  // run sendTx every SEND_TX_INTERVAL
  const interval = eval(process.env.SEND_TX_INTERVAL);
  setInterval(() => {
    sendTx();
  }, interval);
}

main();
