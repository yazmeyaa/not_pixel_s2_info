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

const mintingHistory = []

function getMintedInLast(minutes) {
    const now = Date.now();
    const cutoff = now - getMinutes(minutes);
    const relevant = mintingHistory.filter(entry => entry.time >= cutoff);

    if (relevant.length === 0) return 0;

    const oldest = relevant[0].value;
    const newest = relevant[relevant.length - 1].value;
    return newest - oldest;
}

const startDataCollectiong = async () => {
    setInterval(async () => {
        const collection = await ta.nft.getNftCollection(collectionAddress);
        const entry = {
            time: Date.now(),
            value: collection.nextItemIndex,
        };
        mintingHistory.push(entry);

        const cutoff = Date.now() - getMinutes(60);
        while (mintingHistory.length && mintingHistory[0].time < cutoff) {
            mintingHistory.shift();
        }
    }, getSeconds(2));
}

/**
 * 
 * @returns {Promise<number>}
 */
const getOnlineUsers = createCache(async () => {
    const response = await fetch('https://notpixel.org/api/v1/history/online/stats')
    const json = await response.json()
    return json.current_visitors
}, 1000)

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
    const [bankInfo, currentUsers, tokenStats] = await Promise.all([
        getBankInfo(),
        getOnlineUsers(),
        getTokenStats(),
    ])

    const total = 1024 ** 2;
    const latest = mintingHistory.at(-1)?.value ?? 0;
    const percentage = (latest / total) * 100;
    const left = total - latest;

    await ctx.react('👍')
    await ctx.reply(
        `💰 Tournament Bank: ${bankInfo.toLocaleString('en-US')} $PX (~${(bankInfo * tokenStats.price).toLocaleString('en-US')}$) \n\n` +
        `Pixels to mint left: ${left.toLocaleString('en-US')}◾️\n` +
        `Total pixels: ${total.toLocaleString('en-US')}◾️\n` +
        `Minted: ${percentage.toFixed(2)}%\n\n` +
        `Minted in 5m: ${getMintedInLast(5).toLocaleString('en-US')}◾️\n` +
        `Minted in 10m: ${getMintedInLast(10).toLocaleString('en-US')}◾️\n` +
        `Minted in 30m: ${getMintedInLast(30).toLocaleString('en-US')}◾️\n` +
        `Minted in 60m: ${getMintedInLast(60).toLocaleString('en-US')}◾️\n\n` +
        `🟢 Online users: ${currentUsers.toLocaleString('en-US')}`
    )
});

(async () => {
    startDataCollectiong();

    telegram_app.use(rateLimit({ window: 1000, limit: 1 }))
    telegram_app.launch()
})()