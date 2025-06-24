import { Telegraf } from 'telegraf'
import rateLimit from 'telegraf-ratelimit'
import DB from 'better-sqlite3'
import { TonApiClient } from '@ton-api/client';
import { Address } from '@ton/core'

const db = new DB('db.sqlite');
const telegram_app = new Telegraf(process.env.BOT_TOKEN);

telegram_app.catch(console.error);

const ta = new TonApiClient({
    baseUrl: 'https://tonapi.io',
    apiKey: 'AFRANRCC2VJQ4MQAAAAHZJVF7PB2B5YNVM4GNUJI6VAMNS3VSCVPXSQK5E3DGG3UPDC6CEQ',
});

const cachedUminted = {
    updatedAt: new Date(0),
    count: 0,
}
const collectionAddress = Address.parse('EQDxPnc-hOZTW5pxFFt56pny-W3UuEs7ktzf-tAGNCkxtOl1');

async function updateUnminted(date) {
    const collection = await ta.nft.getNftCollection(collectionAddress)
    cachedUminted.count = (1024 ** 2) - collection.nextItemIndex;
    cachedUminted.updatedAt = date;
}

const getSeconds = (seconds) => 1000 * seconds;

async function getUnminted() {
    const now = new Date();
    if (now.getTime() - cachedUminted.updatedAt.getTime() > getSeconds(3)) {
        await updateUnminted(now);
    }

    return cachedUminted;
}

telegram_app.command('info', async (ctx) => {
    const unmintedInfo = await getUnminted();
    const percentage = (unmintedInfo.count / (1024 ** 2)) * 100;
    await ctx.react('👍')
    await ctx.reply(`Pixels to mint left: ${unmintedInfo.count}\nTotal pixels: ${1024 ** 2}\nMinted: ${100 - percentage.toFixed(2)}%`)
});

(async () => {
    telegram_app.use(rateLimit({ window: 1000, limit: 1 }));
    telegram_app.launch();
})();