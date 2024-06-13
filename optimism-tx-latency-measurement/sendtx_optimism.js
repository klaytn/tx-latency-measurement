// Optimism PoS transaction latency measurement.

import "dotenv/config";

import { Web3 } from "web3";
import fs from "fs";
import AWS from "aws-sdk";
import parquet from "parquetjs-lite";
import moment from "moment";
import axios from "axios";
import CoinGecko from "coingecko-api";
import { Storage } from "@google-cloud/storage";
import { JSONPreset } from "lowdb/node";

let rpc = process.env.PUBLIC_RPC_URL;
const provider = new Web3.providers.HttpProvider(rpc);
const web3 = new Web3(provider);
const CoinGeckoClient = new CoinGecko();

const privateKey = process.env.PRIVATE_KEY;
var PrevNonce = null;

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
  const destFileName = `tx-latency-measurement/optimism/${filename}`;

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

async function uploadToGCSL1(data) {
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
  const destFileName = `tx-latency-measurement/optimisml1/${filename}`;

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
    // Add your private key
    const signer = web3.eth.accounts.privateKeyToAccount(privateKey);
    const balance = Number(await web3.eth.getBalance(signer.address)) * 10 ** -18; //in wei

    if (balance < parseFloat(process.env.BALANCE_ALERT_CONDITION_IN_OPT)) {
      const now = new Date();
      await sendSlackMsg(
        `${now}, Current balance of <${process.env.SCOPE_URL}/address/${signer.address}|${signer.address}> is less than ${process.env.BALANCE_ALERT_CONDITION_IN_OPT} OPT! balance=${balance} OPT`
      );
    }

    const latestNonce = Number(await web3.eth.getTransactionCount(signer.address, "pending")) + 1;
    const currentNonce = Number(await web3.eth.getTransactionCount(signer.address, "pending"));
    if (!!PrevNonce && latestNonce != PrevNonce + 1) {
      // console.log(`Nonce ${latestNonce} = ${PrevNonce}`)
      return;
    }

    const startGetBlock = new Date().getTime();
    const latestBlockNumber = await web3.eth.getBlockNumber();
    const endGetBlock = new Date().getTime();
    data.pingTime = endGetBlock - startGetBlock;

    await web3.eth.getBlock(latestBlockNumber).then((result) => {
      data.resourceUsedOfLatestBlock = Number(result.gasUsed);
      data.numOfTxInLatestBlock = result.transactions.length;
    });

    //create value transfer transaction
    const tx = {
      from: signer.address,
      to: signer.address,
      value: web3.utils.toWei("0", "ether"),
      gas: 21000,
      gasPrice: await web3.eth.getGasPrice(),
    };

    //Sign to the transaction
    var RLPEncodedTx;

    await web3.eth.accounts.signTransaction(tx, privateKey).then((result) => {
      RLPEncodedTx = result.rawTransaction; // RLP encoded transaction & already HEX value
      data.txhash = result.transactionHash; // the transaction hash of the RLP encoded transaction.
    });

    await web3.eth.net.getId().then((result) => {
      data.chainId = Number(result);
    });
    const start = new Date().getTime();
    data.startTime = start;

    // Send signed transaction
    await web3.eth
      .sendSignedTransaction(RLPEncodedTx) // Signed transaction data in HEX format
      .then(function (receipt) {
        PrevNonce = latestNonce;
        data.txhash = receipt.transactionHash;
        const end = new Date().getTime();
        data.endTime = end;
        data.latency = end - start;
        data.txFee =
          Number(receipt.gasUsed) *
          Number(web3.utils.fromWei(Number(receipt.effectiveGasPrice), "ether"));
      });

    const db = await JSONPreset("db.json", { posts: [] });
    db.data.posts.push({
      l2TxHash: data.txhash,
      createdAt: data.executedAt,
      status: "pending",
      l1CommitTiming: null,
    });
    db.write();

    // Calculate Transaction Fee and Get Tx Fee in USD
    var OPTtoUSD;

    await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=optimism&vs_currencies=usd&x_cg_demo_api_key=${process.env.COIN_GECKO_API_KEY}`)
      .then(response => {
        OPTtoUSD = response.data["optimism"].usd;
      });


    data.txFeeInUSD = data.txFee * OPTtoUSD;

    // console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
    try {
      await uploadChoice(data);
    } catch (err) {
      await sendSlackMsg(`failed to upload optimism, ${err.toString()}`);
      console.log(
        `failed to ${process.env.UPLOAD_METHOD === "AWS" ? "s3" : "gcs"}.upload!! Printing instead!`,
        err.toString()
      );
    }
  } catch (err) {
    const now = new Date();
    await sendSlackMsg(`${now}, failed to execute optimism, ${err.toString()}, ${err.stack}`);
    console.log("failed to execute.", err.toString(), err.stack);
    data.error = err.toString();
    console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
  }
}

async function l1Checker() {
  await new Promise((resolve) => setTimeout(resolve, 1000 * 60 * 2));
  const db = await JSONPreset("db.json", { posts: [] });
  for (const post of db.data.posts) {
    console.log(post.l2TxHash);
    const currentTimestamp = new Date().getTime();
    const fortyFiveMinutesAgoTimestamp = currentTimestamp - 1000 * 60 * 45;

    if (post.status === "pending" && post.createdAt < fortyFiveMinutesAgoTimestamp) {
      await l1commitmentprocess(db, post.l2TxHash, post.createdAt);
    }
  }
  await db.write();
}

async function l1commitmentprocess(db, hash, createdAt) {

  var gcpData = {
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

  const response = await fetch(`${process.env.L1FINALITYSCRAPERURL}/root_end?from_chain=10&hash=${hash}`);
  console.log("l1GoResponseOpt", response);
  if (!response.ok) {
    const postIndex = db.data.posts.findIndex((post) => post.l2TxHash === hash);
    if (postIndex !== -1) {
      console.log("L1 tx hash not found");
      db.data.posts[postIndex].status = "failed";
      await sendSlackMsg(`L1 tx hash not found for ${hash}!`);
      return null;
    } else {
      await sendSlackMsg(`l2 ${hash} not found!`);
      return Error("l2TxHash not found.");
    }
  }
  const go_scraper_data = await response.json();
  const finalityTiming = parseInt(go_scraper_data.root_end, 10);
  const timeTaken = finalityTiming - createdAt;

  const postIndex = db.data.posts.findIndex((post) => post.l2TxHash === hash);
  if (postIndex !== -1) {
    db.data.posts[postIndex].l1CommitTiming = timeTaken;
    db.data.posts[postIndex].status = "success";
    gcpData.latency = timeTaken;
    gcpData.hash = hash;
    uploadToGCSL1(gcpData)
  } else {
    await sendSlackMsg(`l2 ${hash} not found!`);
    return Error("l2TxHash not found.");
  }
}


async function main() {
  const start = new Date().getTime();
  console.log(`starting tx latency measurement... start time = ${start}`);

  if (privateKey === "") {
    const account = web3.eth.accounts.create(web3.utils.randomHex(32));
    console.log(`Private key is not defined. Use this new private key(${account.privateKey}).`);
    console.log(
      `Get test tokens from the faucet: https://faucet.triangleplatform.com/optimism/goerli`
    );
    console.log(`Your Optimism address = ${account.address}`);
    return;
  }

  // run sendTx every SEND_TX_INTERVAL
  const interval = eval(process.env.SEND_TX_INTERVAL);
  setInterval(async()=>{
    try{
        await sendTx()
        await l1Checker();
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

try{
    main()
}
catch(err){
    console.log("failed to execute main", err.toString(), err.stack)
}
