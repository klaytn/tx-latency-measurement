const Web3 = require('web3')
const fs = require('fs')
const AWS = require('aws-sdk')
var parquet = require('parquetjs-lite')
const moment = require('moment');
const axios = require('axios');
const CoinGecko = require('coingecko-api');

require("dotenv").config();

let rpc = process.env.PUBLIC_RPC_URL;
const provider = new Web3.providers.HttpProvider(rpc);
const web3 = new Web3(provider);
const CoinGeckoClient = new CoinGecko(); 

var PrevNonce = 0; 

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


async function sendTx(){
  var data = {
    executedAt: new Date().getTime(),
    txhash: '',
    startTime: 0,
    endTime: 0,
    chainId: 0,
    latency:0,
    error:'',
    txFee: 0.0, 
    txFeeInUSD: 0.0, 
    resourceUsedOfLatestBlock: 0,
    numOfTxInLatestBlock: 0,
    pingTime:0 
  }

  try{
    // Add your private key 
    const signer = web3.eth.accounts.privateKeyToAccount(
        process.env.SIGNER_PRIVATE_KEY
    );
    const balance = await web3.eth.getBalance(signer.address); //in wei  

    if(balance*(10**(-18)) < parseFloat(process.env.BALANCE_ALERT_CONDITION_IN_MATIC))
    { 
      sendSlackMsg(`Current balance of <${process.env.SCOPE_URL}/address/${signer.address}|${signer.address}> is less than ${process.env.BALANCE_ALERT_CONDITION_IN_MATIC} MATIC! balance=${balance*(10**(-18))} MATIC`)
    }

    const latestNonce = await web3.eth.getTransactionCount(signer.address)
    if (latestNonce == PrevNonce) 
    {
      console.log(`Nonce ${latestNonce} = ${PrevNonce}`)
      return;
    }
    else{
      console.log(`Nonce ${latestNonce} != ${PrevNonce}`)
    }

    const startGetBlock = new Date().getTime()
    const latestBlockNumber = await web3.eth.getBlockNumber();
    const endGetBlock = new Date().getTime()
    data.pingTime = endGetBlock - startGetBlock

    await web3.eth.getBlock(latestBlockNumber).then((result)=>{
      data.resourceUsedOfLatestBlock = result.gasUsed
      data.numOfTxInLatestBlock = result.transactions.length
    })

    var maxPriorityFeePerGas; 
    var baseFee; 
    // Option 1. Calculate maxPriorityFeePerGas based on Fee History 
    // https://web3js.readthedocs.io/en/v1.5.0/web3-eth.html#getfeehistory
    await web3.eth.getFeeHistory(10, "latest", [50]).then((result)=>{
      baseFee = Number(result.baseFeePerGas[3])// expected base Fee value (in wei)
      var sum = 0
      result.reward.forEach(element => {
        sum += Number(element[0])
      });
      sum /= 10 
      maxPriorityFeePerGas = web3.utils.toHex(Math.round(sum).toString())//in wei 
    });

    // Option 2. Calculate maxPriorityFeePerGas using equation: (gasPrice - baseFee)
    // const gasPrice = await web3.eth.getGasPrice()
    // maxPriorityFeePerGas = web3.utils.toHex((gasPrice - baseFee).toString())

    //create value transfer transaction (EIP-1559) 
    const tx = {
      type: 2,
      nonce: latestNonce,
      from: signer.address,
      to:  signer.address,
      value: web3.utils.toHex(web3.utils.toWei("0", "ether")),
      gas: 21000,
      maxPriorityFeePerGas, // 2.5 Gwei is a default 
      // default maxFeePerGas = (2 * block.baseFeePerGas) + maxPriorityFeePerGas 
    }

    //Sign to the transaction
    var RLPEncodedTx;
    await web3.eth.accounts.signTransaction(tx, process.env.SIGNER_PRIVATE_KEY)
    .then((result) => {
      RLPEncodedTx = result.rawTransaction // RLP encoded transaction & already HEX value
      data.txhash = result.transactionHash // the transaction hash of the RLP encoded transaction.
    });
 
    await web3.eth.net.getId().then((result)=>{
      data.chainId = result 
    })
    const start = new Date().getTime()
    data.startTime = start 

    const originalPrevNonce = PrevNonce

    // Send signed transaction
    await web3.eth
    .sendSignedTransaction(RLPEncodedTx) // Signed transaction data in HEX format 
    .on('sent', function(){
      PrevNonce = latestNonce
    })
    .on('receipt', function(receipt){
      data.txhash = receipt.transactionHash
      const end = new Date().getTime()
      data.endTime = end
      data.latency = end-start
      data.txFee = receipt.gasUsed * web3.utils.fromWei(receipt.effectiveGasPrice.toString())
    })
    .on('error', function(err){
      PrevNonce = originalPrevNonce
    })

    // Calculate Transaction Fee and Get Tx Fee in USD 
    var MATICtoUSD;
    await CoinGeckoClient.simple.price({
      ids: ["matic-network"],
      vs_currencies: ["usd"]
    }).then((response)=>{
      MATICtoUSD = response.data["matic-network"]["usd"]
    })
    data.txFeeInUSD = data.txFee * MATICtoUSD 

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

async function main(){
  const start = new Date().getTime()
  console.log(`starting tx latency measurement... start time = ${start}`)

  // run sendTx every SEND_TX_INTERVAL
  const interval = eval(process.env.SEND_TX_INTERVAL)
  setInterval(()=>{
    sendTx()
  }, interval)

}

main();