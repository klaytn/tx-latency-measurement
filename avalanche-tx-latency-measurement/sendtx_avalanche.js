// Avalanche C-chain transaction latency measurement.
// Reference of Sending Transaction using Javascript: https://docs.avax.network/quickstart/sending-transactions-with-dynamic-fees-using-javascript/
const ethers = require('ethers');
const Avalanche = require('avalanche').Avalanche;
const AWS = require('aws-sdk');
const parquet = require('parquetjs-lite');
const moment = require('moment');
const fs = require('fs');
const axios = require('axios');
const CoinGecko = require('coingecko-api');
const {Storage} = require('@google-cloud/storage');
require('dotenv').config();

var address = "";
var wallet;

const nodeURL = process.env.PUBLIC_RPC_URL;
const HTTPSProvider = new ethers.providers.JsonRpcProvider(nodeURL);

const chainId = process.env.CHAIN_ID;
const avalanche = new Avalanche(process.env.AVALANCHE_HOST, undefined, 'https', chainId);
const cchain = avalanche.CChain();

const CoinGeckoClient = new CoinGecko();
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
        throw ("undefined bucket name");
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
    const destFileName = `tx-latency-measurement/avalanche/${filename}`;

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

// Function to estimate max fee and max priority fee
const calcFeeData = async (maxFeePerGas = undefined, maxPriorityFeePerGas = undefined) => {
    // Get Base Fee: this value is just an estimate
    const baseFee = parseInt(await cchain.getBaseFee(), 16) / 1e9;

    // Calc MaxPriorityFeePerGas and MaxFeePerGas
    maxPriorityFeePerGas = maxPriorityFeePerGas == undefined ? parseInt(await cchain.getMaxPriorityFeePerGas(), 16) / 1e9 : maxPriorityFeePerGas;
    maxFeePerGas = maxFeePerGas == undefined ? 2 * baseFee + maxPriorityFeePerGas : maxFeePerGas;

    if(maxFeePerGas < maxPriorityFeePerGas) {
        throw("Error: Max fee per gas cannot be less than max priority fee per gas");
    }

    return {
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString()
    };
}

// Function to send AVAX
const sendAvax = async (amount, to, maxFeePerGas = undefined, maxPriorityFeePerGas = undefined, nonce = undefined) => {
    var data = {
        executedAt: new Date().getTime(),
        txhash: '',
        startTime: 0,
        endTime: 0,
        chainId: chainId,
        latency:0,
        error:'',
        txFee: 0.0,
        txFeeInUSD: 0.0,
        resourceUsedOfLatestBlock: 0,
        numOfTxInLatestBlock: 0,
        pingTime:0
    }

    try{
        const balance = (await HTTPSProvider.getBalance(address)) * (10**(-18))// getAssetBalance
        if(balance < parseFloat(process.env.BALANCE_ALERT_CONDITION_IN_AVAX))
        {
            const now = new Date();
            await sendSlackMsg(`${now}, Current balance of <${process.env.SCOPE_URL}/address/${address}|${address}> is less than ${process.env.BALANCE_ALERT_CONDITION_IN_AVAX} AVAX! balance=${balance} AVAX`)
        }

        const latestNonce = await HTTPSProvider.getTransactionCount(address);
        if (latestNonce == PrevNonce)
        {
            // console.log(`Nonce ${latestNonce} = ${PrevNonce}`)
            return;
        }

        // Measure latency of getBlockNumber
        const startGetBlockNumber = new Date().getTime()
        const latestBlockNumber = await HTTPSProvider.getBlockNumber()
        const endGetBlockNumber = new Date().getTime()
        data.pingTime = endGetBlockNumber - startGetBlockNumber

        // Get latest block for Network congestion info
        await HTTPSProvider.getBlock(latestBlockNumber).then((res)=>{
            data.numOfTxInLatestBlock = res.transactions.length
            data.resourceUsedOfLatestBlock = Number(res.gasUsed)
        });

        // If the max fee or max priority fee is not provided, then it will automatically calculate using CChain APIs
        ({ maxFeePerGas, maxPriorityFeePerGas } = await calcFeeData(maxFeePerGas, maxPriorityFeePerGas));
        maxFeePerGas = ethers.utils.parseUnits(maxFeePerGas, "gwei");
        maxPriorityFeePerGas = ethers.utils.parseUnits(maxPriorityFeePerGas, "gwei");

        // Type 2 transaction is for EIP1559
        const tx = {
            type: 2,
            nonce: latestNonce,
            to,
            maxPriorityFeePerGas,
            maxFeePerGas,
            value: ethers.utils.parseEther(amount),
            chainId,
        };
        tx.gasLimit = await HTTPSProvider.estimateGas(tx);

        // Sign transaction
        const signedTx = await wallet.signTransaction(tx); //serialized (unsigned tx, signature) : rlp encoded (unsigned tx , signature)
        data.txhash = ethers.utils.keccak256(signedTx);

        // Write starttime
        const start = new Date().getTime()
        data.startTime = start

        // Sending a signed transaction and waiting for its inclusion
        const signature = await (await HTTPSProvider.sendTransaction(signedTx)).wait(); //default confirmation number = 1
        PrevNonce = latestNonce

        // Calculate latency
        const end = new Date().getTime()
        data.endTime = end
        data.latency = end-start

        // Get tx Fee and tx Fee in USD
        var AVAXtoUSD;

        await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=avalanche-2&vs_currencies=usd&x_cg_demo_api_key=${process.env.COIN_GECKO_API_KEY}`)
        .then(response => {
            AVAXtoUSD = response.data["avalanche-2"].usd;
        });

        data.txFee = ethers.utils.formatEther(signature.effectiveGasPrice) * signature.gasUsed;
        data.txFeeInUSD = data.txFee  * AVAXtoUSD;
        // console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
        try{
            await uploadChoice(data)
        } catch(err){
            await sendSlackMsg(`failed to upload avalanche, ${err.toString()}`);
            console.log(`failed to ${process.env.UPLOAD_METHOD === 'AWS'? 's3': 'gcs'}.upload!! Printing instead!`, err.toString())
            console.log(JSON.stringify(data))
        }
    } catch(err){
         const now = new Date();
        await sendSlackMsg(`${now}, failed to execute avalanche, ${err.toString()}, ${err.stack}`);
        console.log("failed to execute.", err.toString(), err.stack)
        data.error = err.toString()
        console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
    }
};

async function main(){
    const start = new Date().getTime()
    console.log(`starting tx latency measurement... start time = ${start}`)

    if(process.env.SIGNER_PRIVATE_KEY === "") {
        const wallet = ethers.Wallet.createRandom()
        console.log(`Private key is not defined. Use this new private key(${wallet.privateKey}).`)
        console.log(`Get test AVAX from the faucet: https://faucet.avax.network/`)
        console.log(`Your Avalanche address = ${wallet.address}`)
        return
    }

    const privateKey = process.env.SIGNER_PRIVATE_KEY;
    wallet = new ethers.Wallet(privateKey);
    address = wallet.address;

    // run sendTx every SEND_TX_INTERVAL(sec).
    


    const interval = eval(process.env.SEND_TX_INTERVAL)

    setInterval(async()=>{
        try{
            await sendAvax("0.0", address);
        } catch(err){
            console.log("failed to execute sendTx", err.toString(), err.stack)
        }
    }, interval)
    try{
        await sendAvax("0.0", address);
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