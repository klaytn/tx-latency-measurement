// Klaytn transaction latency measurement.
// Reference of Sending Transaction using CaverJS: https://docs.kaikas.io/02_api_reference/02_caver_methods
const fs = require('fs')
const Caver = require('caver-js')
const axios = require('axios')
const path = require('path')
var parquet = require('parquetjs-lite');
const AWS = require('aws-sdk');
const moment = require('moment');
const CoinGecko = require('coingecko-api');
const CoinGeckoClient = new CoinGecko();
const {Storage} = require('@google-cloud/storage');

async function uploadToS3(data) {
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
    const destFileName = `tx-latency-measurement/klaytn/${filename}`;

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

    // create new ParquetWriter that writes to 'fruits.parquet`
    var writer = await parquet.ParquetWriter.openFile(schema, filename);

    await writer.appendRow(data)

    await writer.close()

    return filename;
}

function loadConfig() {
    if(process.env.NODE_ENV === undefined) {
        // console.log("using .env")
        require('dotenv').config({path:path.join(__dirname,'.env')})
    } else {
        // console.log(`using .env.${process.env.NODE_ENV}`)
        require('dotenv').config({path:path.join(__dirname,`.env.${process.env.NODE_ENV}`)})
    }
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

async function checkBalance(addr) {
    const caver = new Caver(process.env.CAVER_URL)
    const balance = await caver.rpc.klay.getBalance(addr)
    const balanceInKLAY = caver.utils.convertFromPeb(balance, 'KLAY')
    const now = new Date();
    if(parseFloat(balanceInKLAY) < parseFloat(process.env.BALANCE_ALERT_CONDITION_IN_KLAY)) {
        await sendSlackMsg(`${now}, Current balance of <${process.env.SCOPE_URL}/account/${addr}|${addr}> is less than ${process.env.BALANCE_ALERT_CONDITION_IN_KLAY} KLAY! balance=${balanceInKLAY}`)
    }

}

async function sendTx() {
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

    try {
        const caver = new Caver(process.env.CAVER_URL)
        const keyring = caver.wallet.keyring.createFromPrivateKey(process.env.PRIVATE_KEY)

        caver.wallet.add(keyring)

        checkBalance(keyring.address)

        // Create value transfer transaction
        const vt = caver.transaction.valueTransfer.create({
            from: keyring.address,
            to: keyring.address,
            value: 0,
            gas: 25000,
        })

        // Sign to the transaction
        const signed = await caver.wallet.sign(keyring.address, vt)
        const chainId = caver.utils.hexToNumber(signed.chainId)
        data.chainId = chainId

        // Measure latency of getBlock
        const startGetBlockNumber = new Date().getTime()
        const latestBlockNumber = await caver.klay.getBlockNumber()
        const endGetBlockNumber = new Date().getTime()
        data.pingTime = endGetBlockNumber - startGetBlockNumber

        // Get latest block info
        const blockInfo = await caver.klay.getBlock(latestBlockNumber)
        data.resourceUsedOfLatestBlock = caver.utils.hexToNumber(blockInfo.gasUsed)
        data.numOfTxInLatestBlock = blockInfo.transactions.length

        const start = new Date().getTime()
        data.startTime = start

        // Send transaction to the Klaytn blockchain platform (Klaytn)
        const receipt = await caver.rpc.klay.sendRawTransaction(signed)
        const end = new Date().getTime()

        data.txhash = receipt.transactionHash
        data.endTime = end
        data.latency = end-start

        var KLAYtoUSD;

        await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=klay-token&vs_currencies=usd&x_cg_demo_api_key=${process.env.COIN_GECKO_API_KEY}`)
        .then(response => {
            KLAYtoUSD = response.data["klay-token"].usd;
        });

        data.txFee = caver.utils.convertFromPeb(receipt.gasPrice, 'KLAY') * receipt.gasUsed
        data.txFeeInUSD = KLAYtoUSD * data.txFee
        // console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
        try{
            await uploadChoice(data)
        } catch(err){
            await sendSlackMsg(`failed to upload Klaytn, ${err.toString()}`);
            console.log(`failed to ${process.env.UPLOAD_METHOD === 'AWS'? 's3': 'gcs'}.upload!! Printing instead!`, err.toString())
            console.log(JSON.stringify(data))
        }
    } catch (err) {
         const now = new Date();
        await sendSlackMsg(`${now}, failed to execute Klaytn, ${err.toString()}, ${err.stack}`);
        console.log("failed to execute.", err.toString(), err.stack)
        data.error = err.toString()
        console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
    }
}

async function main() {
    const start = new Date().getTime()
    console.log(`starting tx latency measurement... start time = ${start}`)

    if(process.env.PRIVATE_KEY === "") {
        const caver = new Caver(process.env.CAVER_URL)
        const keyring = caver.wallet.keyring.generate()
        console.log(`Private key is not defined. Use this new private key(${keyring.key.privateKey}).`)
        console.log(`Get test KLAY from the faucet: https://baobab.wallet.klaytn.foundation/faucet`)
        console.log(`Your Klaytn address = ${keyring.address}`)
        return
    }

    // run sendTx every 1 min.
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
loadConfig();
try{
    main()
}
catch(err){
    console.log("failed to execute main", err.toString(), err.stack)
}