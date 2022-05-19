// Polkadot transaction latency measurement. 
// Reference of Sending Transaction using Javascript:
// 1. Transfer Event: https://polkadot.js.org/docs/api/examples/promise/transfer-events
// 2. Transfer error handling: https://polkadot.js.org/docs/extension/cookbook/
// 3. Listen to New blocks: https://polkadot.js.org/docs/api/examples/promise/listen-to-blocks

const { ApiPromise, WsProvider } = require("@polkadot/api");
const { Keyring} = require('@polkadot/keyring');
const fs = require('fs');
const AWS = require('aws-sdk');
const parquet = require('parquetjs-lite');
const moment = require('moment');
const axios = require('axios');
const CoinGecko = require('coingecko-api');
const CoinGeckoClient = new CoinGecko();
require("dotenv").config();
var api= null;
//Construct 
const wsProvider = new WsProvider(process.env.NETWORK_ENDPOINT)

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
    try{
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
    } catch(err){
        console.log('failed to s3.upload', err.toString())
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
        if (api == null)
        {
            api = await ApiPromise.create({provider: wsProvider});
        }
        const keyring = new Keyring({type: 'sr25519'});
        const sender = keyring.addFromMnemonic(process.env.SENDER_MNEMONIC);
        const senderAddress = sender.toJson().address;
        const accountInfo  = await api.query.system.account(senderAddress);  
        //mainnet: 10**(-10) & testnet westend: 10**(-12)
        const balance = Number(accountInfo.toJSON().data.free) * (10**(-12))
    
        if(balance < parseFloat(process.env.BALANCE_ALERT_CONDITION_IN_DOT))
        {
            sendSlackMsg(`Current balance of <${process.env.SCOPE_URL}/account/${senderAddress}|${senderAddress}> is less than ${process.env.BALANCE_ALERT_CONDITION_IN_DOT} DOT! balance=${balance} DOT`)
        }
 
        const startGetBlock = new Date().getTime()
        const unsubscribe = await api.rpc.chain.subscribeNewHeads(async (header)=>{
            const latestBlockNumber = header.toJSON().number;
            const endGetBlock = new Date().getTime();
            data.pingTime = endGetBlock - startGetBlock;        
            unsubscribe();

            const unsubscribeLatestBlockHash = await api.rpc.chain.getBlockHash(latestBlockNumber, async (latestBlockHash)=>{
                unsubscribeLatestBlockHash();
                // Calculate the number of transactions and resource used in the latest block.
                const unsubscribeLatestBlockInfo = await api.rpc.chain.getBlock(latestBlockHash, async(latestBlockInfo)=>{
                    const transactions = latestBlockInfo.toJSON().block.extrinsics;
                    unsubscribeLatestBlockInfo();
                    data.numOfTxInLatestBlock = transactions.length;
                    var weightUsed = 0
                    for await (const tx of transactions)
                    {
                        const paymentInfo = await api.rpc.payment.queryInfo(tx)
                        weightUsed += Number(paymentInfo.toJSON().weight)
                    }
                    data.resourceUsedOfLatestBlock = Math.round(weightUsed * (10**(-9)))

                    // Create value transfer transaction.
                    const transfer = api.tx.balances.transfer(senderAddress, 0);

                    // Sign transaction. 
                    await transfer.signAsync(sender);

                    // Send Transaction and wait until the transaction is in block.
                    const start = new Date().getTime()
                    data.startTime = start 
                    const unsubscribeTransactionSend = await transfer.send(async (result) => {
                        if(result.isInBlock)
                        {  
                            unsubscribeTransactionSend();
                            const end = new Date().getTime()
                            data.endTime = end
                            data.latency = end-start
                            data.txhash = '0x' + Buffer.from(result.txHash).toString('hex')
                            
                            //Calculate tx using BlockHash and txIndex
                            const unsubBlockInfo = await api.rpc.chain.getBlock(result.toHuman().status.InBlock, async (blockInfo)=>{
                                unsubBlockInfo();
                                const feeDetails = await api.rpc.payment.queryFeeDetails(blockInfo.toJSON().block.extrinsics[result.txIndex]); //parameter is BlockHash
                                const inclusionFee = feeDetails.toJSON().inclusionFee;
                                //Mainnet: (10**(-10)) since Denomination day, Testnet WestEnd: (10**(-12))
                                data.txFee = (inclusionFee.baseFee + inclusionFee.lenFee + inclusionFee.adjustedWeightFee)*(10**(-12))

                                //Calculate txFee in USD 
                                var DOTtoUSD;
                                await CoinGeckoClient.simple.price({
                                    ids: ["polkadot"],
                                    vs_currencies: ["usd"]
                                }).then((response)=>{
                                    DOTtoUSD = response.data["polkadot"]["usd"]
                                })
                                data.txFeeInUSD = data.txFee * DOTtoUSD                
                                console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
                                await uploadToS3(data);
                            });
                        }
                    })
                });      
            });


        });
    } catch(err){
        console.log("failed to execute.", err.toString())
        data.error = err.toString()
        console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
        uploadToS3(data)
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