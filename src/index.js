import { Telegraf } from 'telegraf'
import rateLimit from 'telegraf-ratelimit'
import DB from 'better-sqlite3'
import { TonApiClient } from '@ton-api/client';
import { Address } from '@ton/core'

const telegram_app = new Telegraf(process.env.BOT_TOKEN);
const getSeconds = (seconds) => 1000 * seconds;


telegram_app.catch(console.error);

const ta = new TonApiClient({
    baseUrl: 'https://tonapi.io',
    apiKey: 'AFRANRCC2VJQ4MQAAAAHZJVF7PB2B5YNVM4GNUJI6VAMNS3VSCVPXSQK5E3DGG3UPDC6CEQ',
});

const cachedUminted = {
    updatedAt: new Date(0),
    count: 0,
    previousCount: 0,
    mintedPerMinute: 0
}

setInterval(async () => {
    try {
        const now = new Date();
        await updateUnminted(now);

        const delta = cachedUminted.previousCount - cachedUminted.count;
        cachedUminted.mintedPerMinute = delta > 0 ? delta : 0;
        cachedUminted.previousCount = cachedUminted.count;

        console.log(`[${now.toISOString()}] Minted per minute: ${cachedUminted.mintedPerMinute}`);
    } catch (err) {
        console.error('Error in minute snapshot:', err);
    }
}, getSeconds(60));

const collectionAddress = Address.parse('EQDxPnc-hOZTW5pxFFt56pny-W3UuEs7ktzf-tAGNCkxtOl1');

async function updateUnminted(date) {
    const collection = await ta.nft.getNftCollection(collectionAddress)
    cachedUminted.count = (1024 ** 2) - collection.nextItemIndex;
    cachedUminted.updatedAt = date;
}


async function getUnminted() {
    const now = new Date();

    
    if (now.getTime() - cachedUminted.updatedAt.getTime() > getSeconds(3)) {
        await updateUnminted(now);
    }
    if(cachedUminted.previousCount === 0) {
        cachedUminted.previousCount = cachedUminted.count
    }

    return cachedUminted;
}

telegram_app.command('info', async (ctx) => {
    const unmintedInfo = await getUnminted();
    const percentage = (unmintedInfo.count / (1024 ** 2)) * 100;
    await ctx.react('👍')
    await ctx.reply(
        `Pixels to mint left: ${unmintedInfo.count.toLocaleString()}\n` +
        `Total pixels: ${(1024 ** 2).toLocaleString()}\n` +
        `Minted: ${(100 - percentage.toFixed(2))}%\n` +
        `Minted per minute: ${cachedUminted.mintedPerMinute}`
    );
});

(async () => {
    telegram_app.use(rateLimit({ window: 1000, limit: 1 }));
    telegram_app.launch();
})();