const fs = require('fs')
const { AptosAccount, isValidPath, derivePath, HexString, CoinClient, AptosClient } = require("aptos");
const axios = require('axios')
const path = require('path')
require('dotenv').config()
var parquet = require('parquetjs-lite');
const AWS = require('aws-sdk');
const bip39 =  require("@scure/bip39");
const moment = require('moment');
const CoinGecko = require('coingecko-api');

const CoinGeckoClient = new CoinGecko();
const {Storage} = require('@google-cloud/storage');

async function ye(){

async function fromDerivePath(path, mnemonics) {
    if (!isValidPath(path)) {
    throw new Error("Invalid derivation path");
    }

    // converts bytes to hex string
    function toHexString(byteArray) {
        return Array.from(byteArray, function(byte) {
          return ('0' + (byte & 0xFF).toString(16)).slice(-2);
        }).join('')
      }

    const normalizeMnemonics = mnemonics
    .trim()
    .split(/\s+/)
    .map((part) => part.toLowerCase())
    .join(" ");

    const { key } = derivePath(path, toHexString(bip39.mnemonicToSeedSync(normalizeMnemonics)));

    const client = new AptosClient(process.env.NODE_URL);
    const coinClient = new CoinClient(client); 


    const account = new AptosAccount(new Uint8Array(key));
    let txnHash = await coinClient.transfer(account, account, 0, { gasUnitPrice: BigInt(100) }); 
  //  console.log(txnHash)
    const balance = await coinClient.checkBalance(account)
    //console.log(account.accountAddress.hexString)

    const transactionDetail = await client.getTransactionByHash("0xca2fe811c637c0c405549c400908ef74dfaa6b2bb1f8bda564d68211e1a9be90")
    const gasUsed = transactionDetail.gas_used
    const gasUniPri = transactionDetail.gas_unit_price
    const gasfee = gasUsed*gasUniPri * Math.pow(10, -8)

   //console.log(transactionDetail)
    var APTOStoUSD;
        await CoinGeckoClient.simple.price({
            ids: ['aptos'],
            vs_currencies:['usd']
        }).then((response)=> {
            APTOStoUSD = response.data['aptos']['usd']
        })
        //data.txFee = caver.utils.convertFromPeb(receipt.gasPrice, 'KLAY') * receipt.gasUsed
        //data.txFeeInUSD = KLAYtoUSD * data.txFee
        console.log(APTOStoUSD * gasfee)

    return new AptosAccount(new Uint8Array(key));
}
    const derivPath = "m/44'/637'/0'/0'/0'"
    const account = fromDerivePath(derivPath, process.env.MNEMONICS)

    const client = new AptosClient(process.env.NODE_URL);
    const latestblock = await client.getLedgerInfo()
    //console.log(latestblock)
    const latestinfo = await client.getBlockByVersion(latestblock.ledger_version)
    //console.log(latestinfo)

    //const coinClient = new CoinClient(client); 
  //  let txnHash = await coinClient.transfer(account, account, 1, { gasUnitPrice: BigInt(100) }); 
    //console.log(txnHash)

    

}

ye()
