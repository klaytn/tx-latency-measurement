const web3 = require("@solana/web3.js");
const Base58 = require('base-58');
const parquet = require('parquetjs-lite');
const moment = require('moment');
const AWS = require('aws-sdk');
const fs = require('fs');
const axios = require('axios');
const CoinGecko = require('coingecko-api');
const CoinGeckoClient = new CoinGecko();

require('dotenv').config();
const keypair = web3.Keypair.fromSecretKey(Base58.decode(process.env.SIGNER_PRIVATE_KEY)); //Base58 encoded private key (64 byte)-> generate keypair 
const connection = new web3.Connection(web3.clusterApiUrl(process.env.CLUSTER_NAME), 'confirmed'); //To use mainnet, use 'mainnet-beta'

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

async function sendSlackMsg(msg) {
  axios.post(process.env.SLACK_API_URL, {
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

async function sendZeroSol(){
  var data = {
    executedAt: new Date().getTime(),
    txhash: '', // Solana has no txHash. Instead, it uses tx signature. 
    startTime: 0,
    endTime: 0,
    chainId: process.env.CHAIN_ID, //Solana has no chainId. 
    latency:0,
    error:'',
    txFee: 0.0, 
    txFeeInUSD: 0.0, 
    resourceUsedOfLatestBlock: 0,
    numOfTxInLatestBlock: 0,
    pingTime:0
  } 

  try{
    //check balance 
    const balance = await connection.getBalance(keypair.publicKey)
    if(balance*(10**(-9)) < parseFloat(process.env.BALANCE_ALERT_CONDITION_IN_SOL))
    { 
      sendSlackMsg(`Current balance of <${process.env.SCOPE_URL}/address/${keypair.publicKey}?cluster=${process.env.CLUSTER_NAME}|${keypair.publicKey}> is less than ${process.env.BALANCE_ALERT_CONDITION_IN_SOL} SOL! balance=${balance*(10**(-9))} SOL`)
    }
  
    const startGetBlockHash = new Date().getTime();
    var blockhash;
    await connection.getLatestBlockhashAndContext().then(async (result)=>{
      // Measure Latency for getLatestBlock
      const endGetBlockHash = new Date().getTime()
      data.pingTime = endGetBlockHash - startGetBlockHash; 
      blockhash = result.value.blockhash
      // Get the number of processed transactions 
      await connection.getBlock(result.context.slot).then((response)=>{
        data.numOfTxInLatestBlock = response.transactions.length
      });
      // Get the number of Singatures in the block 
      await connection.getBlockSignatures(result.context.slot).then((res)=>{
        data.resourceUsedOfLatestBlock = res.signatures.length
      })
    })

    const instruction = web3.SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: keypair.publicKey, 
      lamports: 0, 
    });

    const tx = new web3.Transaction({
      recentBlockhash: blockhash,
      feePayer: keypair.publicKey
    }).add(instruction);
    tx.sign(keypair)

    // Write starttime 
    const start = new Date().getTime()
    data.startTime = start

    // Send signed transaction and wait til confirmation
    const signature = await web3.sendAndConfirmRawTransaction(
      connection,
      tx.serialize(), // tx serialized in wire format 
    )

    // Calc latency 
    const end = new Date().getTime()
    data.endTime = end
    data.latency = end-start
    data.txhash = signature // same with base58.encode(tx.signature)

    var SOLtoUSD;
    await CoinGeckoClient.simple.price({
      ids: ['solana'],
      vs_currencies: ['usd']
    }).then((response)=>{
      SOLtoUSD = response.data['solana']['usd']
    })

    const response = await connection.getFeeForMessage(
      tx.compileMessage(),
      'confirmed',
    );
    const feeInLamports = response.value;

    data.txFee = feeInLamports * 10**(-9)
    data.txFeeInUSD = SOLtoUSD * data.txFee
    console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
  } catch(err){
    console.log("failed to execute.", err.toString())
    data.error = err.toString()
    console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
  }
  try{
    await uploadToS3(data)
  } catch(err){
    console.log('failed to s3.upload', err.toString())
  }
}

async function main (){
  const start = new Date().getTime()
  console.log(`starting tx latency measurement... start time = ${start}`)

  // run sendTx every SEND_TX_INTERVAL(sec).
  const interval = eval(process.env.SEND_TX_INTERVAL)
      setInterval(()=>{
      sendZeroSol();
  }, interval)
}

main();