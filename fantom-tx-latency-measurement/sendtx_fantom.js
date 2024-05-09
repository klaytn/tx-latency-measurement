// Fantom transaction latency measurement.
// Reference of Sending Transaction using Javascript: https://github.com/Fantom-foundation/fantom-web3-wallet/blob/master/index.js

const Web3 = require('web3');
const fs = require('fs')
const AWS = require('aws-sdk')
const parquet = require('parquetjs-lite')
const moment = require('moment');
const axios = require('axios');
const CoinGecko = require('coingecko-api');
const CoinGeckoClient = new CoinGecko();
const {Storage} = require('@google-cloud/storage');

require('dotenv').config();

const web3 = new Web3(new Web3.providers.HttpProvider(process.env.PUBLIC_RPC_URL_WEB3));
const privateKey = process.env.SIGNER_PRIVATE_KEY;
var PrevNonce = null;

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

    await writer.close()

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
    if(process.env.S3_BUCKET === "") {
        throw "undefined bucket name"
    }

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
    const destFileName = `tx-latency-measurement/fantom/${filename}`;

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
        const signer = web3.eth.accounts.privateKeyToAccount(
            process.env.SIGNER_PRIVATE_KEY
        );
        const balance = (await web3.eth.getBalance(signer.address)) * (10**(-18))

        if(balance < parseFloat(process.env.BALANCE_ALERT_CONDITION_IN_FTM))
        {
            const now = new Date();
            await sendSlackMsg(`${now}, Current balance of <${process.env.SCOPE_URL}/address/${signer.address}|${signer.address}> is less than ${process.env.BALANCE_ALERT_CONDITION_IN_FTM} FTM! balance=${balance} FTM`)
        }

        await web3.eth.net.getId().then((id)=>{
            data.chainId = id
        })
        const gasPrice = await web3.eth.getGasPrice();
        if (gasPrice * (10**(-9)) > process.env.MAX_GAS_PRICE)
        {
            console.log(`Gas Price ${gasPrice*(10**(-9))} Gwei is bigger than Gas Price limit ${process.env.MAX_GAS_PRICE} Gwei.`)
            return;
        }

        const latestNonce = await web3.eth.getTransactionCount(signer.address);
        if (latestNonce == PrevNonce)
        {
        //   console.log(`Nonce ${latestNonce} = ${PrevNonce}`)
          return;
        }

        const startGetBlock = new Date().getTime()
        const latestBlockNumber = await web3.eth.getBlockNumber();
        const endGetBlock = new Date().getTime()
        data.pingTime = endGetBlock - startGetBlock

        await web3.eth.getBlock(latestBlockNumber).then((blockInfo)=>{
            data.resourceUsedOfLatestBlock = blockInfo.gasUsed
            data.numOfTxInLatestBlock = blockInfo.transactions.length
        })

        const rawTx = {
            from: signer.address,
            to: signer.address,
            value: Web3.utils.toHex(Web3.utils.toWei("0", 'ether')),
            gasLimit: Web3.utils.toHex(21000),
            gasPrice: Web3.utils.toHex(gasPrice),
            nonce: Web3.utils.toHex(latestNonce)
        }

        var RLPEncodedTx;
        await web3.eth.accounts.signTransaction(rawTx, privateKey)
        .then((result)=>
        {
            RLPEncodedTx = result.rawTransaction // RLP encoded transaction & already HEX value
            data.txhash = result.transactionHash // the transaction hash of the RLP encoded transaction.
        })

        const originalPrevNonce = PrevNonce
        // Send signed transaction
        const start = new Date().getTime()
        data.startTime = start
        await web3.eth
        .sendSignedTransaction(RLPEncodedTx)
        .on('sent', function(){
            PrevNonce = latestNonce
        })
        .on('receipt', function(receipt){
            const end = new Date().getTime()
            data.endTime = end
            data.latency = end-start
            try{
                data.txFee = receipt.gasUsed * web3.utils.fromWei(receipt.effectiveGasPrice.toString())
            }
            catch(err){
                console.log("failed to calculate txFee", err.toString())
            }
        })
        .on('error', function(err){
            PrevNonce = originalPrevNonce
        })

        if (!data.txFee) {
            await new Promise(resolve => setTimeout(resolve, 30000));
            let result = await web3.eth.getTransactionReceipt(data.txhash)
            data.txFee = result.gasUsed * web3.utils.fromWei(result.effectiveGasPrice.toString())
        }

        // Calculate Transaction Fee and Get Tx Fee in USD
        var FTMtoUSD;

        await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=fantom&vs_currencies=usd&x_cg_demo_api_key=${process.env.COIN_GECKO_API_KEY}`)
        .then(response => {
            FTMtoUSD = response.data["fantom"].usd;
        });

        data.txFeeInUSD = data.txFee * FTMtoUSD

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
    } catch(err){
        const now = new Date();
        await sendSlackMsg(`${now}, failed to execute fantom, ${err.toString()}, ${err.stack}`);
        console.log("failed to execute.", err.toString(), err.stack)
        data.error = err.toString()
        console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
    }
}

async function main(){
    const start = new Date().getTime()
    console.log(`starting tx latency measurement... start time = ${start}`)

    if(privateKey === "") {
        const account = web3.eth.accounts.create(web3.utils.randomHex(32));
        console.log(`Private key is not defined. Use this new private key(${account.privateKey}).`)
        console.log(`Get test FTM from the faucet: https://faucet.fantom.network/`)
        console.log(`Your Fantom address = ${account.address}`)
        return
    }

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