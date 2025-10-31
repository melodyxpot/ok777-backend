import * as tr from 'tronweb';
import BigNumber from 'bignumber.js';
import {
    getAllWallets,
    saveTransaction,
    topBalance,
    minusBalance,
    getBalance
} from '../db/wallets';
import { decryptPrivateKey } from '../utils/bcrypt';
import { convert } from '../utils/exchange';
import 'dotenv/config';


let tronWebInstance: any | null = null;
function getTronWeb() {
    const url = process.env.TRON_FULLNODE;
    if (!url || !/^https?:\/\//.test(url)) {
        throw new Error('TRON_FULLNODE is not configured as a valid http(s) URL');
    }
    if (!tronWebInstance) {
        tronWebInstance = new tr.TronWeb({ fullHost: url });
    }
    return tronWebInstance;
}
const MAIN_POOL_ADDRESS = process.env.TRON_MAIN_POOL_ADDRESS;
const MAIN_POOL_PK = process.env.TRON_MAIN_POOL_PK;
const USDT_CONTRACT = process.env.TRON_USDT_CONTRACT;
const MIN_SWEEP_USDT = 10;
const GAS_AMOUNT = 2_000_000;

let lastBlockNumber = 0;
let wallets = [];

setInterval(async () => {
    wallets = await getAllWallets("Tron");
}, 10000);


const pollBlocks = async () => {

    const tronWeb = getTronWeb();
    const currentBlock = await tronWeb.trx.getCurrentBlock();
    const currentBlockNumber = currentBlock.block_header.raw_data.number;

    if (!lastBlockNumber) lastBlockNumber = currentBlockNumber - 1;

    for (let bn = lastBlockNumber + 1; bn <= currentBlockNumber; bn++) {
        const block = await tronWeb.trx.getBlock(bn);
        if (!block.transactions) continue;

        for (const tx of block.transactions) {
            for (const c of tx.raw_data.contract) {
                if (c.type === 'TransferContract') {
                    const data = c.parameter.value;
                    const to = tronWeb.address.fromHex(data['to_address']);
                    const amount = new BigNumber(data['amount']).div(1e6); // TRX has 6 decimals

                    const addr = wallets.find(a => a.publicKey === to);
                    if (addr && amount.gt(0)) {
                        const incomingTxId = tx.txID;
                        console.log(`TRX deposit detected: ${amount.toString()} to ${to}`);
                        console.log(`Incoming TRX: ${amount.toString()} to ${to}`);
                        if (amount.toNumber() > 5) {
                            transferToMain(addr, amount, incomingTxId);
                        }
                    }
                }
            }
        }
    }

    lastBlockNumber = currentBlockNumber;

}

const transferToMain = async (wallet: any, amount: BigNumber, txId: string) => {

    try {

        const pkFrom = await decryptPrivateKey(wallet.privateKey);
        const tronWebIns = new tr.TronWeb({ fullHost: process.env.TRON_FULLNODE });
        tronWebIns.setPrivateKey(pkFrom);

        const feeBuffer = new BigNumber(0.1);

        const amountToSend = amount.minus(feeBuffer);

        const amountSun = new BigNumber(amountToSend).multipliedBy(1e6).toNumber();
        const tx = await tronWebIns.trx.sendTransaction(MAIN_POOL_ADDRESS, amountSun);
        const amountUSD = await convert(amount, "TRX", "USDT");
        await saveTransaction(wallet.userId, wallet.publicKey, amountToSend.toNumber(), "TRX", txId, "deposit");
        await topBalance(wallet.userId, amountUSD, "USD");

        console.log(`✅ Swept ${amountToSend} TRX from ${wallet.publicKey} → main pool`);
        console.log(`TxID: ${tx.txid}`);

    } catch (err) {
        console.log(err);
    }

}


const waitForConfirmation = async (txId: string, timeout = 60000) => {
    const tronWeb = getTronWeb();
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const receipt = await tronWeb.trx.getTransactionInfo(txId);
        if (receipt && receipt.receipt) return receipt;
        await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error(`Tx ${txId} not confirmed within timeout`);
};

export const maybeSweepUserDeposit = async (
    depositAddr: string,
    depositPk: string,
    incomingTxId: string,
    userId: number,
    balanceRaw: any,
	) => {

	const tw = getTronWeb();
	const balance = parseFloat(tw.toBigNumber(balanceRaw).div(1e6).toString());

    if (balance < MIN_SWEEP_USDT) {
        console.log(`⏳ Balance ${balance} USDT < ${MIN_SWEEP_USDT}, skip sweep`);
        return;
    }

    console.log(`✅ ${balance} USDT detected, sweeping to main pool...`);
	// check TRX balance for fees
	const trxBalance = await tw.trx.getBalance(depositAddr);
    if (trxBalance < GAS_AMOUNT) {
        console.log("Gas top")
	const tronWebIns = getTronWeb();
        tronWebIns.setPrivateKey(MAIN_POOL_PK);
        const { txid } = await tronWebIns.trx.sendTransaction(depositAddr, GAS_AMOUNT,);
        console.log(`💸 Funded gas: 2 TRX to ${depositAddr}, tx: ${txid}`);
        await waitForConfirmation(txid);
    }

    const tronWebIns = getTronWeb();
    tronWebIns.setPrivateKey(decryptPrivateKey(depositPk));
    console.log("Send")
    const contract2 = await tronWebIns.contract().at(USDT_CONTRACT);
    const txId = await contract2.transfer(MAIN_POOL_ADDRESS, balanceRaw).send({
        feeLimit: 100_000_000,  // energy limit
        callValue: 0,           // TRX amount to send (0 for tokens)
        shouldPollResponse: true
    });
    console.log(`🚀 Swept ${balance} USDT → main pool, tx: ${txId}`);

	const amountToSend = tw.toBigNumber(balanceRaw).div(1e6);

    await saveTransaction(userId, depositAddr, amountToSend.toNumber(), "USDT", incomingTxId, "deposit");
    await topBalance(userId, amountToSend.toNumber(), "USD");

    console.log("Balance updated.")

    return txId;
};


const checkBalances = async () => {
    try {

        const tronWebIns = getTronWeb();
        const contract = await tronWebIns.contract().at(USDT_CONTRACT);


        for (const wallet of wallets) {
            const addr = wallet.publicKey;

            const balanceRaw = await contract.balanceOf(addr).call({ from: wallet.publicKey });
            const balance = new BigNumber(balanceRaw).div(1e6);

            if (balance.gte(MIN_SWEEP_USDT)) {
                console.log(`💰 Sweeping ${balance.toString()} USDT from ${addr} to main pool`);
                try {
                    await maybeSweepUserDeposit(wallet.publicKey, wallet.privateKey, '-', wallet.userId, balanceRaw)
                } catch (err) {
                    console.error(`Sweep failed for ${addr}:`, err);
                }
            }
        }
    } catch (err) {
        console.error('Error checking balances:', err);
    }

    setTimeout(checkBalances, 60 * 1000)
};


export const startObserverTron = () => {
    checkBalances();
    setInterval(pollBlocks, 3000);
}

export const withdrawTokenTron = async (userId: number, to: string, amount: number) => {

    const tronWebIns = getTronWeb();
    tronWebIns.setPrivateKey(MAIN_POOL_PK);

    const contract = await tronWebIns.contract().at(USDT_CONTRACT);

    const rawAmount = new BigNumber(amount).times(1e6).toFixed(0);

    console.log(`🚀 Withdrawing ${amount} USDT from main pool -> ${to}`);

    const txId = await contract.transfer(to, rawAmount).send({
        feeLimit: 100_000_000,
        callValue: 0,
        shouldPollResponse: true
    });

    await saveTransaction(userId, to, -amount, "USDT", '-', "withdraw")

    console.log(`✅ Withdrawal successful | TxID: ${txId}`);
    return txId;

};

export const withdrawTrx = async (userId: number, to: string, amount: number) => {


    const tronWebIns = getTronWeb();
    tronWebIns.setPrivateKey(MAIN_POOL_PK);

    const rawAmount = new BigNumber(parseInt(amount.toString())).times(1e6);

    console.log(`🚀 Withdrawing ${amount} TRX to ${to}`);

    const tx = await tronWebIns.trx.sendTransaction(to, rawAmount.toNumber());

    if (!tx?.txid) throw new Error('Tx failed or not broadcasted');

    console.log(`✅ Tx confirmed: ${tx.txid}`);

    await saveTransaction(userId, to, -amount, "TRX", tx.txid, "withdraw")

    console.log(`📉 User ${userId} TRX balance reduced by ${amount}`);

};


export const withdrawTrxOnchain = async (to: string, amount: number) => {

    const tronWebIns = new tr.TronWeb({ fullHost: process.env.TRON_FULLNODE });
    tronWebIns.setPrivateKey(MAIN_POOL_PK);

    const rawAmount = new BigNumber(amount).times(1e6);

    console.log(`🚀 Withdrawing ${amount} TRX to ${to}`);

    const tx = await tronWebIns.trx.sendTransaction(to, rawAmount.toNumber());

    if (!tx?.txid) throw new Error('Tx failed or not broadcasted');

    console.log(`✅ Tx confirmed: ${tx.txid}`);

};

export const withdrawTokenTronOnchain = async (to: string, amount: number) => {

    const tronWebIns = new tr.TronWeb({ fullHost: process.env.TRON_FULLNODE });
    tronWebIns.setPrivateKey(MAIN_POOL_PK);

    const contract = await tronWebIns.contract().at(USDT_CONTRACT);

    const rawAmount = new BigNumber(amount).times(1e6).toFixed(0);

    console.log(`🚀 Withdrawing ${amount} USDT from main pool -> ${to}`);

    const txId = await contract.transfer(to, rawAmount).send({
        feeLimit: 100_000_000,
        callValue: 0,
        shouldPollResponse: true
    });

    console.log(`✅ Withdrawal successful | TxID: ${txId}`);
    
    return txId;

};