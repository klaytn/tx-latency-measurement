// Polkadot transaction latency measurement.
// Reference of Sending Transaction using Javascript:
// 1. Transfer Event: https://polkadot.js.org/docs/api/examples/promise/transfer-events
// 2. Transfer error handling: https://polkadot.js.org/docs/extension/cookbook/
// 3. Listen to New blocks: https://polkadot.js.org/docs/api/examples/promise/listen-to-blocks
// 4. QueryFeeDetails: https://spec.polkadot.network/chap-runtime-api#sect-rte-transactionpaymentapi-query-fee-details

const { ApiPromise, WsProvider } = require("@polkadot/api");
const { Keyring } = require("@polkadot/keyring");
const { mnemonicGenerate } = require("@polkadot/util-crypto");
const fs = require("fs");
const AWS = require("aws-sdk");
const parquet = require("parquetjs-lite");
const moment = require("moment");
const axios = require("axios");
const CoinGecko = require("coingecko-api");
const CoinGeckoClient = new CoinGecko();
const { Storage } = require("@google-cloud/storage");
require("dotenv").config();
var api = null;

//Construct
const wsProvider = new WsProvider(process.env.NETWORK_ENDPOINT);

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
  try {
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
  } catch (err) {
    console.log("failed to s3.upload! Printing instead!", err.toString());
    console.log(JSON.stringify(data));
  }
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
  const destFileName = `tx-latency-measurement/polkadot/${filename}`;

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
    const keyring = new Keyring({ type: "sr25519" });
    const sender = keyring.addFromMnemonic(process.env.SENDER_MNEMONIC);
    const senderAddress = sender.toJson().address;
    const accountInfo = await api.query.system.account(senderAddress);
    //Mainnet: (10**(-10)) since Denomination day, Testnet WestEnd: (10**(-12))
    const decimal = process.env.NETWORK_ENDPOINT.includes("westend") ? 10 ** -12 : 10 ** -10;
    const balance = Number(accountInfo.toJSON().data.free) * decimal;

    if (balance < parseFloat(process.env.BALANCE_ALERT_CONDITION_IN_DOT)) {
      sendSlackMsg(
        `Current balance of <${process.env.SCOPE_URL}/account/${senderAddress}|${senderAddress}> is less than ${process.env.BALANCE_ALERT_CONDITION_IN_DOT} DOT! balance=${balance} DOT`
      );
    }

    const startGetBlock = new Date().getTime();
    const header = await api.rpc.chain.getFinalizedHead();
    const endGetBlock = new Date().getTime();
    const latestBlockHash = header.toJSON();
    data.pingTime = endGetBlock - startGetBlock;

    // Calculate the number of transactions and resource used in the latest block.
    const latestBlockInfo = await api.rpc.chain.getBlock(latestBlockHash);

    const transactions = latestBlockInfo.toJSON().block.extrinsics;
    data.numOfTxInLatestBlock = transactions.length;
    var weightUsed = 0;
    for await (const tx of transactions) {
      const paymentInfo = await api.call.transactionPaymentApi.queryInfo(tx, 1);
      weightUsed += Number(paymentInfo.toJSON().weight.refTime);
    }
    data.resourceUsedOfLatestBlock = Math.round(weightUsed * 10 ** -9);

    // Create value transfer transaction.
    const transfer = api.tx.balances.transfer(senderAddress, 0);

    // Sign transaction.
    await transfer.signAsync(sender);

    // Send Transaction and wait until the transaction is in block.
    const start = new Date().getTime();
    data.startTime = start;
    const unsubscribeTransactionSend = await transfer.send(async (result) => {
      if (result.isInBlock) {
        unsubscribeTransactionSend();
        const end = new Date().getTime();
        data.endTime = end;
        data.latency = end - start;
        data.txhash = "0x" + Buffer.from(result.txHash).toString("hex");

        //Calculate tx using BlockHash and txIndex
        const blockInfo = await api.rpc.chain.getBlock(result.toHuman().status.InBlock);
        const feeDetails = await api.rpc.payment.queryFeeDetails(
          blockInfo.toJSON().block.extrinsics[result.txIndex]
        ); //parameter is BlockHash
        const inclusionFee = feeDetails.toJSON().inclusionFee;
        data.txFee =
          (inclusionFee.baseFee + inclusionFee.lenFee + inclusionFee.adjustedWeightFee) * decimal;

        //Calculate txFee in USD
        var DOTtoUSD;
        await CoinGeckoClient.simple
          .price({
            ids: ["polkadot"],
            vs_currencies: ["usd"],
          })
          .then((response) => {
            DOTtoUSD = response.data["polkadot"]["usd"];
          });
        data.txFeeInUSD = data.txFee * DOTtoUSD;
        console.log(
          `${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`
        );
        await uploadChoice(data);
      }
    });
  } catch (err) {
    sendSlackMsg(`Failed to execute, ${err.toString()}`);
    console.log("failed to execute.", err.toString());
    data.error = err.toString();
    console.log(
      `${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`
    );
    uploadChoice(data);
  }
}

async function main() {
  const start = new Date().getTime();
  console.log(`starting tx latency measurement... start time = ${start}`);
  api = await ApiPromise.create({ provider: wsProvider });
  if (process.env.SENDER_MNEMONIC === "") {
    const newMnemonic = mnemonicGenerate();
    const keyring = new Keyring({ type: "sr25519" });
    const address = keyring.addFromMnemonic(newMnemonic).toJson().address;
    console.log(`MNEMONIC is undefined. Use this new MNEMONIC: ${newMnemonic}`);
    console.log(
      `Get test DOT from the faucet: https://matrix.to/#/!cJFtAIkwxuofiSYkPN:matrix.org?via=matrix.org&via=matrix.parity.io&via=web3.foundation`
    );
    console.log(`Your Polkadot address = ${address}`);
    console.log(`To exit, press Ctrl+C.`);
    return;
  }

  // run sendTx every SEND_TX_INTERVAL
  const interval = eval(process.env.SEND_TX_INTERVAL);
  setInterval(() => {
    sendTx();
  }, interval);
}

main();
