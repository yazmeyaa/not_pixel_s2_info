import { Telegraf } from 'telegraf'
import rateLimit from 'telegraf-ratelimit'
import { TonApiClient } from '@ton-api/client'
import { Address } from '@ton/core'

const telegram_app = new Telegraf(process.env.BOT_TOKEN)
const getSeconds = (seconds) => 1000 * seconds;
const getMinutes = (minutes) => getSeconds(60) * minutes;

telegram_app.catch(console.error)

const createCache = (fn, ttlMs) => {
    let cache = null;
    let cacheTime = 0;

    return async () => {
        const now = Date.now();
        if (cache && now - cacheTime < ttlMs) {
            return cache;
        }
        cache = await fn();
        cacheTime = now;
        return cache;
    };
};

const ta = new TonApiClient({
    baseUrl: 'https://tonapi.io',
    apiKey: 'AFRANRCC2VJQ4MQAAAAHZJVF7PB2B5YNVM4GNUJI6VAMNS3VSCVPXSQK5E3DGG3UPDC6CEQ',
})
const collectionAddress = Address.parse('EQDxPnc-hOZTW5pxFFt56pny-W3UuEs7ktzf-tAGNCkxtOl1')


const hourlySnapshot = {
    initiated: false,
    total: 0,
    "5m": 0,
    "10m": 0,
    "30m": 0,
    "1h": 0,
}

async function updateSnapshot() {
    const collection = await ta.nft.getNftCollection(collectionAddress);
    if (!hourlySnapshot.initiated) {
        hourlySnapshot['5m'] = collection.nextItemIndex;
        hourlySnapshot['10m'] = collection.nextItemIndex;
        hourlySnapshot['30m'] = collection.nextItemIndex;
        hourlySnapshot['1h'] = collection.nextItemIndex;
        hourlySnapshot.initiated = true;

    }
    const now = new Date();
    const minutes = now.getMinutes();

    if (minutes === 0) {
        hourlySnapshot['1h'] = collection.nextItemIndex;
    } else if (minutes % 30 === 0) {
        hourlySnapshot['30m'] = collection.nextItemIndex;
    } else if (minutes % 10 === 0) {
        hourlySnapshot['10m'] = collection.nextItemIndex;
    } else if (minutes % 5 === 0) {
        hourlySnapshot['5m'] = collection.nextItemIndex;
    }
}

const startDataCollectiong = async () => {
    setInterval(() => {
        updateSnapshot()
    }, getMinutes(1));

    setInterval(async () => {
        const collection = await ta.nft.getNftCollection(collectionAddress);
        hourlySnapshot.total = collection.nextItemIndex;
    }, getSeconds(2));
}



/**
 * 
 * @returns {Promise<number>}
 */
const getOnlineUsers = async () => {
    const response = await fetch('https://notpixel.org/api/v1/history/online/stats')
    const json = await response.json()
    return json.current_visitors
}

const getBankInfo = createCache(async () => {
    const response = await fetch('https://notpixel.org/api/v1/battle-canvas/info');
    const json = await response.json();
    return json.rewardBank;
}, 2000);

const getTokenStats = createCache(async () => {
    const response = await fetch('https://notpixel.org/api/v1/history/px/stats');
    const json = await response.json();
    return json;
}, 2000);

telegram_app.command('info', async (ctx) => {
    const prCurrentUsers = getOnlineUsers()
    const prBankInfo = getBankInfo()
    const prTokenStats = getTokenStats()

    const [bankInfo, currentUsers, tokenStats] = await Promise.all([prBankInfo, prCurrentUsers, prTokenStats])

    const total = 1024 ** 2;
    const percentage = (hourlySnapshot.total / total) * 100
    const left = (1024 ** 2) - hourlySnapshot.total


    await ctx.react('👍')
    await ctx.reply(
        `💰 Tournament Bank: ${bankInfo.toLocaleString('en-US')} $PX (~${(bankInfo * tokenStats.price).toLocaleString('en-US')}$) \n\n` +
        `Pixels to mint left: ${left.toLocaleString('en-US')}◾️\n` +
        `Total pixels: ${(1024 ** 2).toLocaleString('en-US')}◾️\n` +
        `Minted: ${(percentage).toFixed(2)}%\n\n` +
        `Minted in 5m: ${(hourlySnapshot.total - hourlySnapshot['5m']).toLocaleString('en-US')}◾️\n` +
        `Minted in 10m: ${(hourlySnapshot.total - hourlySnapshot['10m']).toLocaleString('en-US')}◾️\n` +
        `Minted in 30m: ${(hourlySnapshot.total - hourlySnapshot['30m']).toLocaleString('en-US')}◾️\n` +
        `Minted in 60m: ${(hourlySnapshot.total - hourlySnapshot['1h']).toLocaleString('en-US')}◾️\n\n` +
        `🟢 Online users: ${currentUsers.toLocaleString('en-US')}`
    )
});

(async () => {
    startDataCollectiong();
    updateSnapshot();

    telegram_app.use(rateLimit({ window: 1000, limit: 1 }))
    telegram_app.launch()
})()