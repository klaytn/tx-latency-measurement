// Sui transaction latency measurement.
// Reference of Sending Transaction: https://sui-wallet-kit.vercel.app/typescript/transaction-building/basics#inputs-and-transactions
require("dotenv").config();
const fs = require("fs");
const axios = require("axios");
const path = require("path");
var parquet = require("parquetjs-lite");
const AWS = require("aws-sdk");
const moment = require("moment");
const CoinGecko = require("coingecko-api");
const CoinGeckoClient = new CoinGecko();
const { Storage } = require("@google-cloud/storage");

const { getFullnodeUrl, SuiClient } = require("@mysten/sui.js/client");
const { getFaucetHost, requestSuiFromFaucetV0 } = require("@mysten/sui.js/faucet");
const { MIST_PER_SUI } = require("@mysten/sui.js/utils");
const { Ed25519Keypair, Ed25519PublicKey } = require("@mysten/sui.js/keypairs/ed25519");
const { TransactionBlock } = require("@mysten/sui.js/transactions");
const { verifyTransactionBlock } = require("@mysten/sui.js/verify");

const client = new SuiClient({ url: getFullnodeUrl(process.env.NETWORK_ID) });

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
  const destFileName = `tx-latency-measurement/sui/${filename}`;

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

  // create new ParquetWriter that writes to 'fruits.parquet`
  var writer = await parquet.ParquetWriter.openFile(schema, filename);

  await writer.appendRow(data);

  await writer.close();

  return filename;
}

function loadConfig() {
  if (process.env.CHAIN_ID === undefined) {
    // console.log("using .env")
    require("dotenv").config({ path: path.join(__dirname, ".env") });
  } else {
    // console.log(`using .env.${process.env.CHAIN_ID}`)
    require("dotenv").config({ path: path.join(__dirname, `.env.${process.env.CHAIN_ID}`) });
  }
}

async function sendSlackMsg(msg) {
  await axios.post(
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

async function checkBalance(addr) {
  const balance = await client.getCoins({ owner: addr });
  if (parseFloat(balance) < parseFloat(process.env.BALANCE_ALERT_CONDITION_IN_SUI)) {
    const now = new Date();
    await sendSlackMsg(
      `${now}, Current balance of <${process.env.SCOPE_URL}/address/${addr}=${process.env.CHAIN_ID}|${addr}> is less than ${process.env.BALANCE_ALERT_CONDITION_IN_SUI} SUI! balance=${balance}`
    );
  }
}

async function sendTx() {
  var data = {
    executedAt: new Date().getTime(),
    txhash: "",
    startTime: 0,
    endTime: 0,
    chainId: 0,
    latency: 0,
    error: "",
    txFee: 0.0,
    txFeeInUSD: 0.0,
    resourceUsedOfLatestBlock: 0,
    numOfTxInLatestBlock: 0,
    pingTime: 0,
  };

  try {
    // get private key from env
    const keypair = Ed25519Keypair.deriveKeypair(process.env.PRIVATE_KEY);

    const client = new SuiClient({ url: getFullnodeUrl(process.env.NETWORK_ID) });

    const bytes = keypair.getPublicKey().toRawBytes();
    const publicKey = new Ed25519PublicKey(bytes);
    const address = publicKey.toSuiAddress();

    checkBalance(address);

    // Measure latency of getBlock
    const startGetBlockNumber = new Date().getTime();
    const latestSequenceNumber = await client.getLatestCheckpointSequenceNumber();
    const endGetBlockNumber = new Date().getTime();
    data.pingTime = endGetBlockNumber - startGetBlockNumber;

    // Get latest block info
    const blockInfo = await client.getCheckpoint({ id: latestSequenceNumber });
    data.resourceUsedOfLatestBlock = blockInfo.epochRollingGasCostSummary.computationCost;
    data.numOfTxInLatestBlock = blockInfo.transactions.length;

    // Create transaction
    const tx = new TransactionBlock();
    const [coin] = tx.splitCoins(tx.gas, [tx.pure(0)]);
    tx.transferObjects([coin], tx.pure(keypair.getPublicKey().toSuiAddress()));

    // Latency
    const start = new Date().getTime();
    data.startTime = start;

    // Send transaction to the Sui Blockchain
    const transfer = await client.signAndExecuteTransactionBlock({
      signer: keypair,
      transactionBlock: tx,
    });
    const end = new Date().getTime();
    data.endTime = end;
    data.latency = end - start;
    data.txhash = transfer.digest;
    data.chainId = process.env.CHAIN_ID;

    await new Promise((resolve) => setTimeout(resolve, 30000));
    const transactionBlockDetails = await client.getTransactionBlock({
      digest: transfer.digest,
      options: {
        showEffects: true,
        showInput: true,
        showEvents: true,
        showObjectChanges: false,
        showBalanceChanges: true,
      },
    });

    const computationCost = parseInt(transactionBlockDetails.effects.gasUsed.computationCost, 10);
    const storageCost = parseInt(transactionBlockDetails.effects.gasUsed.storageCost, 10);
    const storageRebate = parseInt(transactionBlockDetails.effects.gasUsed.storageRebate, 10);

    const totalFeeinMist = computationCost + storageCost - storageRebate;
    txfee = totalFeeinMist / Math.pow(10, 9);

    var SUItoUSD;

      await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd&x_cg_demo_api_key=${process.env.COIN_GECKO_API_KEY}`)
      .then(response => {
        SUItoUSD = response.data["sui"].usd;
      });

    data.txFee = 1997880 / Math.pow(10, 9);
    data.txFeeInUSD = SUItoUSD * txfee;
    // console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
    try {
      await uploadChoice(data);
    } catch (err) {
      await sendSlackMsg(`failed to upload sui, ${err.toString()}`);
      console.log(
        `failed to ${process.env.UPLOAD_METHOD === "AWS" ? "s3" : "gcs"}.upload!! Printing instead!`,
        err.toString()
      );
      console.log(JSON.stringify(data));
    }
  } catch (err) {
     const now = new Date();
    await sendSlackMsg(`${now}, failed to execute sui, ${err.toString()}, ${err.stack}`);
    console.log("failed to execute.", err.toString(), err.stack);
    data.error = err.toString();
    console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
  }

}

async function main() {
  const start = new Date().getTime();
  console.log(`starting tx latency measurement... start time = ${start}`);

  if (process.env.PRIVATE_KEY === "") {
    console.log(
      `Private key is not defined. Create a wallet in https://chrome.google.com/webstore/detail/sui-wallet/opcgpfmipidbgpenhmajoajpbobppdil`
    );
    console.log(`Get test SUI from the faucet: https://faucet.triangleplatform.com/sui/testnet`);
    return;
  }

  // run sendTx every 1 min..
  const interval = eval(process.env.SEND_TX_INTERVAL);
  setInterval(async()=>{
    try{
        await sendTx()
    } catch(err){
        console.log("failed to execute sendTx", err.toString(), err.stack)
    }
}, interval)
try{
    await sendTx()
} catch(err){
    console.log("failed to execute sendTx", err.toString(), err.stack)
}
}
loadConfig();
try{
    main()
}
catch(err){
    console.log("failed to execute main", err.toString(), err.stack)
}
