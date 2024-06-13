// Near Protocol transaction latency measurement. 
// Reference of Sending Transaction using Javascript: https://github.com/near-examples/transaction-examples/blob/master/send-tokens-deconstructed.js  & https://docs.near.org/docs/api/rpc 
const nearAPI = require('near-api-js');
const sha256 = require('js-sha256');
const AWS = require('aws-sdk');
const parquet = require('parquetjs-lite');
const moment = require('moment');
const axios = require('axios');
const CoinGecko = require('coingecko-api');
const fs = require('fs');
const CoinGeckoClient = new CoinGecko();
const {Storage} = require('@google-cloud/storage');
 
//this is required if using a local .env file for private key
require('dotenv').config();

// configure accounts, network, and amount of NEAR to send
// the amount is converted into yoctoNEAR (10^-24) using a near-api-js utility
const sender = process.env.SENDER_ACCOUNT_ID;
const networkId = process.env.NETWORK_ID;
const amount = nearAPI.utils.format.parseNearAmount('0.0');
var PrevNonce = null;

// sets up a NEAR API/RPC provider to interact with the blockchain
const provider = new nearAPI.providers
  .JsonRpcProvider({
      url :`https://rpc.${networkId}.near.org`,
  });

// creates keyPair used to sign transaction
var keyPair;

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
    const destFileName = `tx-latency-measurement/near/${filename}`;

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

async function sendTx() {
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

    try {
        const accountInfo = await provider.query({
            request_type: "view_account",
            finality: "final",
            account_id: sender,
        });
        const balance = Number(accountInfo.amount) * (10**(-24))
        if(balance < parseFloat(process.env.BALANCE_ALERT_CONDITION_IN_NEAR))
        {
            const now = new Date();
            await sendSlackMsg(`${now}, Current balance of <${process.env.SCOPE_URL}/accounts/${sender}|${sender}> is less than ${process.env.BALANCE_ALERT_CONDITION_IN_NEAR} NEAR! balance=${balance} NEAR`)
        }

        // gets sender's public key
        const publicKey = keyPair.getPublicKey();

        // gets sender's public key information from NEAR blockchain 
        const accessKey = await provider.query(
            `access_key/${sender}/${publicKey.toString()}`, ''
        );

        // checks to make sure provided key is a full access key
        if(accessKey.permission !== 'FullAccess') {
            return console.log(
                `Account [ ${sender} ] does not have permission to send tokens using key: [ ${publicKey} ]`
            );
        }

        // each transaction requires a unique number or nonce
        // this is created by taking the current nonce and incrementing it
        const nonce = ++accessKey.nonce;
        //check nonce 
        if (nonce == PrevNonce)
        {
            // console.log(`Nonce ${nonce} = ${PrevNonce}`)
            return;
        }

        // constructs actions that will be passed to the createTransaction method below
        const actions = [nearAPI.transactions.transfer(amount)];

        // converts a recent block hash into an array of bytes 
        // this hash was retrieved earlier when creating the accessKey 
        // this is required to prove the tx was recently constructed (within 24hrs)
        const recentBlockHash = nearAPI.utils.serialize.base_decode(accessKey.block_hash);
        const startGetBlock = new Date().getTime()
        const block = await provider.sendJsonRpc(
            'block', 
            [accessKey.block_hash]
        );
        const endGetBlock = new Date().getTime()
        data.pingTime = endGetBlock - startGetBlock

        var chunkList = [] 

        block.chunks.forEach(element => {
            chunkList.push(element.chunk_hash)
            });

        // Get GasUsed and latest block 
        var gasUsed = 0
        var numTx = 0
        for (let i = 0; i < chunkList.length; i++) {
            const chunk = await provider.sendJsonRpc(
                'chunk',
                [chunkList[i]]
            )
            // console.log(chunk, chunk.header.gas_used)
            gasUsed += Number(chunk.header.gas_used)
            numTx += chunk.transactions.length
        }
        data.numOfTxInLatestBlock = numTx
        data.resourceUsedOfLatestBlock = Math.round(gasUsed * (10**(-9)))//in unit of Ggas (10**9) 
        
        // create transaction
        const transaction = nearAPI.transactions.createTransaction(
            sender, 
            publicKey, 
            sender,
            nonce,
            actions,
            recentBlockHash
        );

        // before we can sign the transaction we must perform three steps...
        // 1) serialize the transaction in Borsh
        const serializedTx = nearAPI.utils.serialize.serialize(
            nearAPI.transactions.SCHEMA, 
            transaction
        );
        // 2) hash the serialized transaction using sha256
        const serializedTxHash = new Uint8Array(sha256.sha256.array(serializedTx));
        // 3) create a signature using the hashed transaction
        const signature = keyPair.sign(serializedTxHash);

        // now we can sign the transaction :)
        const signedTransaction = new nearAPI.transactions.SignedTransaction({
            transaction,
            signature: new nearAPI.transactions.Signature({ 
                keyType: transaction.publicKey.keyType, 
                data: signature.signature 
            })
        });

        // send the transaction!
        // encodes signed transaction to serialized Borsh (required for all transactions)
        const signedSerializedTx = signedTransaction.encode();
        // start time 
        const start = new Date().getTime()
        data.startTime = start
        // sends transaction to NEAR blockchain via JSON RPC call and records the result
        const originalPrevNonce = PrevNonce
        PrevNonce = nonce
        const result = await provider.sendJsonRpc(
            'broadcast_tx_commit', 
            [Buffer.from(signedSerializedTx).toString('base64')]
        );

        if (!result.status.hasOwnProperty('SuccessValue')) {
            PrevNonce = originalPrevNonce
            throw new Error("Tx execution was not succeeded.");
        }
        const end = new Date().getTime()
        data.latency = end - start 
        data.txhash = result.transaction.hash
        data.endTime = end

        //calculate TxFee and TxFee in USD
        data.txFee = (Number(result.transaction_outcome.outcome.tokens_burnt) + Number(result.receipts_outcome[0].outcome.tokens_burnt))*(10**(-24))
        var NEARtoUSD;

        await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd&x_cg_demo_api_key=${process.env.COIN_GECKO_API_KEY}`)
        .then(response => {
            NEARtoUSD = response.data["near"].usd;
        });

        data.txFeeInUSD = data.txFee * NEARtoUSD
        // console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
        try{
            await uploadChoice(data)
        } catch(err){
            await sendSlackMsg(`failed to upload Near, ${err.toString()}`);
            console.log(`failed to ${process.env.UPLOAD_METHOD === 'AWS'? 's3': 'gcs'}.upload!! Printing instead!`, err.toString())
            console.log(JSON.stringify(data))
        }
    } catch(err){
         const now = new Date();
    await sendSlackMsg(`${now}, failed to execute Near, ${err.toString()}, ${err.stack}`);
        console.log("failed to execute.", err.toString(), err.stack)
        data.error = err.toString()
        console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
    }
}

async function main (){
    const start = new Date().getTime()
    console.log(`starting tx latency measurement... start time = ${start}`)

    if (process.env.SENDER_PRIVATE_KEY === "") {
        console.log(`Private key is not defined.`)
        console.log(`Create a new Account using testnet wallet: https://wallet.testnet.near.org/`)
        console.log(`Then update SENDER_ACCOUNT_ID and SENDER_PRIVATE_KEY in .env file.`)
        return
    }

    keyPair = nearAPI.utils.key_pair.KeyPairEd25519.fromString(process.env.SENDER_PRIVATE_KEY);
    
    // run sendTx every SEND_TX_INTERVAL(sec).
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
    
    
  

// run the function
try{
    main()
}
catch(err){
    console.log("failed to execute main", err.toString(), err.stack)
}