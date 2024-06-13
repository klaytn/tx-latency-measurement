// Aptos transaction latency measurement.

const fs = require("fs");
const { AptosAccount, isValidPath, derivePath, CoinClient, AptosClient } = require("aptos");
const axios = require("axios");
const path = require("path");
var parquet = require("parquetjs-lite");
const AWS = require("aws-sdk");
const bip39 = require("@scure/bip39");
const moment = require("moment");
const CoinGecko = require("coingecko-api");

const CoinGeckoClient = new CoinGecko();
const { Storage } = require("@google-cloud/storage");

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
  const destFileName = `tx-latency-measurement/aptos/${filename}`;

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
  if (process.env.NODE_URL === undefined) {
    // console.log("using .env")
    require("dotenv").config({ path: path.join(__dirname, ".env") });
  } else {
    // console.log(`using .env.${process.env.NODE_URL}`)
    require("dotenv").config({ path: path.join(__dirname, `.env.${process.env.NODE_URL}`) });
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
    function fromDerivePath(path, mnemonics) {
      if (!isValidPath(path)) {
        throw new Error("Invalid derivation path");
      }

      // converts bytes to hex string
      function toHexString(byteArray) {
        return Array.from(byteArray, function (byte) {
          return ("0" + (byte & 0xff).toString(16)).slice(-2);
        }).join("");
      }

      const normalizeMnemonics = mnemonics
        .trim()
        .split(/\s+/)
        .map((part) => part.toLowerCase())
        .join(" ");

      const { key } = derivePath(path, toHexString(bip39.mnemonicToSeedSync(normalizeMnemonics)));

      return new AptosAccount(new Uint8Array(key));
    }
    const derivPath = "m/44'/637'/0'/0'/0'";
    const account = fromDerivePath(derivPath, process.env.MNEMONICS);

    const address = account.accountAddress.hexString;

    const client = new AptosClient(process.env.NODE_URL);
    const coinClient = new CoinClient(client);
    const balance = await coinClient.checkBalance(account);

    if (balance < parseFloat(process.env.BALANCE_ALERT_CONDITION_IN_APTOS)) {
      const now = new Date();
      await sendSlackMsg(
        `${now}, Current balance of <${process.env.SCOPE_URL}/address/${address}|${address}> is less than ${process.env.BALANCE_ALERT_CONDITION_IN_APTOS} APTOS! balance=${balance} APTOS`
      );
    }

    // Measure ping
    const startGetBlockNumber = new Date().getTime();
    const latestblock = await client.getLedgerInfo();
    const endGetBlockNumber = new Date().getTime();
    data.pingTime = endGetBlockNumber - startGetBlockNumber;

    // Get latest block info
    const blockInfo = await client.getBlockByHeight(latestblock.block_height);
    data.resourceUsedOfLatestBlock = 0;
    data.numOfTxInLatestBlock = 0;

    // Transaction latency
    const start = new Date().getTime();
    data.startTime = start;
    let txnHash = await coinClient.transfer(account, account, 0, {
    gasUnitPrice: BigInt(100),
    maxGasAmount: BigInt(10),
    });
    const end = new Date().getTime();

    data.txhash = txnHash;
    data.endTime = end;
    data.latency = end - start;
    data.chainId = process.env.CHAIN_ID;
    await client.waitForTransactionWithResult(txnHash)

    var APTOStoUSD;

    await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=aptos&vs_currencies=usd&x_cg_demo_api_key=${process.env.COIN_GECKO_API_KEY}`)
    .then(response => {
      APTOStoUSD = response.data["aptos"].usd;
    });

    const transactionDetail = await client.getTransactionByHash(txnHash);
    const gasUsed = transactionDetail.gas_used;
    const gasUnitPrice = transactionDetail.gas_unit_price;
    const txfee = gasUsed * gasUnitPrice * Math.pow(10, -8);
    data.txFee = txfee;
    data.txFeeInUSD = APTOStoUSD * data.txFee;
    // console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
    try {
      await uploadChoice(data);
    } catch (err) {
      await sendSlackMsg(`failed to upload aptos, ${err.toString()}`);
      console.log(
        `failed to ${process.env.UPLOAD_METHOD === "AWS" ? "s3" : "gcs"}.upload!! Printing instead!`,
        err.toString()
      );
      console.log(JSON.stringify(data));
    }
  } catch (err) {
    const now = new Date();
    await sendSlackMsg(`${now}, failed to execute aptos, ${err.toString()}, ${err.stack}`);
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
      `Private key is not defined. Create a wallet in https://petra.app/ and paste Mnemonics.`
    );
    console.log(`Get test APTOS from the faucet: https://www.aptosfaucet.com/`);

    return;
  }

  // run sendTx every SEND_TX_INTERVAL
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
