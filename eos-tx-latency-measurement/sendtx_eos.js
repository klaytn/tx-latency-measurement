// EOS transaction latency measurement. 
// Reference of Sending Token using EOSJS library: https://developers.eos.io/manuals/eosjs/latest/how-to-guides/how-to-transfer-an-eosio-token 

const { JsonRpc, Api } = require('eosjs');
const { JsSignatureProvider } = require('eosjs/dist/eosjs-jssig'); // development only
const { TextEncoder, TextDecoder } = require('util');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const AWS = require('aws-sdk');
const parquet = require('parquetjs-lite');
const moment = require('moment');
const axios = require('axios');
const CoinGecko = require('coingecko-api');
const fs = require('fs');
const CoinGeckoClient = new CoinGecko();
const {Storage} = require('@google-cloud/storage');

require("dotenv").config();

const defaultPrivateKey = process.env.SINGER_PRIVATE_KEY;
const signatureProvider = new JsSignatureProvider([defaultPrivateKey]);

const rpc = new JsonRpc(process.env.PUBLIC_RPC_URL, {fetch});
const api = new Api({rpc, signatureProvider, textDecoder: new TextDecoder(), textEncoder: new TextEncoder()});
const accountId = process.env.ACCOUNT_ID;
const receiverId = process.env.RECEIVER_ID;

async function makeParquetFile(data) {
  var schema = new parquet.ParquetSchema({
      executedAt:{type:'TIMESTAMP_MILLIS'},
      txhash:{type:'UTF8'},
      startTime:{type:'TIMESTAMP_MILLIS'},
      endTime:{type:'TIMESTAMP_MILLIS'},
      chainId:{type:'INT64'},
      latency:{type:'INT64'},
      error:{type:'UTF8'},
      txFee:{type:'DOUBLE'},
      txFeeInUSD:{type:'DOUBLE'},
      resourceUsedOfLatestBlock:{type:'INT64'},
      numOfTxInLatestBlock:{type:'INT64'},
      pingTime:{type:'INT64'}
  })

  var d = new Date()
  //20220101_032921
  var datestring = moment().format('YYYYMMDD_HHmmss')

  var filename = `${datestring}_${data.chainId}.parquet`

  // create new ParquetWriter that writes to 'filename'
  var writer = await parquet.ParquetWriter.openFile(schema, filename);

  await writer.appendRow(data)
  writer.close()
  return filename;
}  

async function sendSlackMsg(msg) {
  await axios.post(process.env.SLACK_API_URL, {
      'channel':process.env.SLACK_CHANNEL,
      'mrkdown':true,
      'text':msg
  }, {
      headers: {
          'Content-type':'application/json',
          'Authorization':`Bearer ${process.env.SLACK_AUTH}`
      }
  })
}

async function uploadToS3(data){
  const s3 = new AWS.S3();
  const filename = await makeParquetFile(data)
  const param = {
    'Bucket':process.env.S3_BUCKET,
    'Key':filename,
    'Body':fs.createReadStream(filename),
    'ContentType':'application/octet-stream'
  }
  await s3.upload(param).promise()

  fs.unlinkSync(filename) 
}  


async function uploadToGCS(data) {
    if(process.env.GCP_PROJECT_ID === "" || process.env.GCP_KEY_FILE_PATH === "" || process.env.GCP_BUCKET === "") {
        throw "undefined parameters"
    }

    const storage = new Storage({
            projectId: process.env.GCP_PROJECT_ID,
            keyFilename: process.env.GCP_KEY_FILE_PATH
    });

    const filename = await makeParquetFile(data)
    const destFileName = `tx-latency-measurement/eos/${filename}`;

    async function uploadFile() {
        const options = {
          destination: destFileName,
    };

    await storage.bucket(process.env.GCP_BUCKET).upload(filename, options);
    console.log(`${filename} uploaded to ${process.env.GCP_BUCKET}`);
  }

    await uploadFile().catch(console.error);
    fs.unlinkSync(filename)
}

async function uploadChoice(data) {
    if (process.env.UPLOAD_METHOD === "AWS") {
        await uploadToS3(data)
    }
    else if  (process.env.UPLOAD_METHOD === "GCP") {
        await uploadToGCS(data)
    }
    else {
        throw "Improper upload method"
    }
}

async function sendTx(){
  var data = {
    executedAt: new Date().getTime(),
    txhash: '',
    startTime: 0,
    endTime: 0,
    chainId: process.env.CHAIN_ID,
    latency:0,
    error:'',
    txFee: 0.0,
    txFeeInUSD: 0.0,
    resourceUsedOfLatestBlock: 0,
    numOfTxInLatestBlock: 0,
    pingTime:0
  }
  
  try{
    const info = await rpc.get_info();

    // Get latest block & measure pingTime 
    const startGetBlock = new Date().getTime()
    const blockInfo = await rpc.get_block(info.head_block_num)// head_block_num = Highest block number on the chain
    const endGetBlock = new Date().getTime()
    data.pingTime = endGetBlock - startGetBlock

    var cpuUsed = 0; 
    for(let i = 0; i < blockInfo.transactions.length; i++){
      cpuUsed += Number(blockInfo.transactions[i].cpu_usage_us)
    }
    data.resourceUsedOfLatestBlock = cpuUsed;
    data.numOfTxInLatestBlock = blockInfo.transactions.length;
    
    const accountInfo = await rpc.get_account(accountId);

    // Calculate CPU price using cpu_limit and staked balance 
    const cpuPrice = Number(accountInfo.total_resources.cpu_weight.split(' ')[0]) / Number(accountInfo.cpu_limit.max) 

    // Check if balance is enough
    const balance = Number(accountInfo.core_liquid_balance.split(' ')[0]); // in TNT(=Temporary Network Token (TNT))    
    if(balance < parseFloat(process.env.BALANCE_ALERT_CONDITION_IN_EOS))
    {
      const now = new Date();
      //testnet : https://testnet.eos.io/blockchain-accounts/{accountId}
      await sendSlackMsg(`${now}, Current balance of <${process.env.SCOPE_URL}/blockchain-accounts/${accountId}|${accountId}> is less than ${process.env.BALANCE_ALERT_CONDITION_IN_EOS} EOS! balance=${balance} EOS`)
    }
    
    //not broadcast, sign transaction. 
    const signedTx = await api.transact({
      actions: [{
        account: "eosio.token",
        name: "transfer",
        authorization: [{
          actor: accountId,
          permission: "active",
        }],
        data: {
          from: accountId,
          to: receiverId,
          quantity: "0.0001 TNT", //Should be changed to EOS from TNT when using Mainnet.  
          memo: ""
        }
      }]
    }, {
      blocksBehind: 3,
      expireSeconds: 200,
      broadcast: false
    });
    //Send Transaction and Measure Latency 
    const start = new Date().getTime()
    data.startTime = start
    const result = await rpc.send_transaction(signedTx);
    const end = new Date().getTime()
    data.latency = end - start 
    data.txhash = result.transaction_id
    data.endTime = end 
  
    // Calculate CPU fee and CPU fee in USD 
    data.txFee = cpuPrice * result.processed.receipt.cpu_usage_us;
    var EOStoUSD;

    await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=eos&vs_currencies=usd&x_cg_demo_api_key=${process.env.COIN_GECKO_API_KEY}`)
    .then(response => {
      EOStoUSD = response.data["eos"].usd;
    });

    data.txFeeInUSD = data.txFee * EOStoUSD 
    console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
    try{
      await uploadChoice(data)
  } catch(err){
    await sendSlackMsg(`failed to upload eos, ${err.toString()}`);
      console.log(`failed to ${process.env.UPLOAD_METHOD === 'AWS'? 's3': 'gcs'}.upload!! Printing instead!`, err.toString())
      console.log(JSON.stringify(data))
  }
  } catch(err){
       const now = new Date();
    await sendSlackMsg(`${now}, failed to execute eos, ${err.toString()}, ${err.stack}`);
      console.log("failed to execute.", err.toString(), err.stack)
      data.error = err.toString()
      console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
  }
}

async function main(){
  const start = new Date().getTime()
  console.log(`starting tx latency measurement... start time = ${start}`)

  // run sendTx every SEND_TX_INTERVAL
  const interval = eval(process.env.SEND_TX_INTERVAL)
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

try{
    main()
}
catch(err){
    console.log("failed to execute main", err.toString(), err.stack)
}