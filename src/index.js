import { Telegraf } from 'telegraf'
import rateLimit from 'telegraf-ratelimit'
import { TonApiClient } from '@ton-api/client'
import { Address } from '@ton/core'
import SQLite3 from 'better-sqlite3'
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';

/** @type {Buffer | null} */
globalThis.chartBankReward = null;
/** @type {Buffer | null} */
globalThis.chartOnline = null;
/** @type {Buffer | null} */
globalThis.chartMintedPixels = null;


const width = 800;
const height = 400;
const chartCallback = (ChartJS) => {
    ChartJS.defaults.font.family = 'Arial';
    ChartJS.defaults.font.size = 12;
};

const canvasRenderService = new ChartJSNodeCanvas({ width, height, chartCallback });

/**
 * @param {Array<Metric>} metrics
 */
async function renderMetricsCharts(metrics) {
    const labels = metrics.map(m => new Date(m.ts).toLocaleTimeString('en-US', { hour12: false }));

    const values = {
        bank_reward: metrics.map(m => m.bank_reward),
        current_online: metrics.map(m => m.current_online),
        minted_pixels: metrics.map(m => m.minted_pixels),
    };

    const datasets = {
        bank_reward: {
            label: 'Bank Reward ($PX)',
            data: values.bank_reward,
            borderColor: 'rgba(255, 99, 132, 1)',
            backgroundColor: 'rgba(255, 99, 132, 0.2)',
        },
        current_online: {
            label: 'Online Users',
            data: values.current_online,
            borderColor: 'rgba(54, 162, 235, 1)',
            backgroundColor: 'rgba(54, 162, 235, 0.2)',
        },
        minted_pixels: {
            label: 'Minted Pixels',
            data: values.minted_pixels,
            borderColor: 'rgba(75, 192, 192, 1)',
            backgroundColor: 'rgba(75, 192, 192, 0.2)',
        }
    };

    const buildOptions = (title, dataArray) => {
        const min = Math.min(...dataArray);
        const max = Math.max(...dataArray);
        const delta = max - min;
        const margin = delta > 0 ? delta * 0.1 : max * 0.01; // 10% от разброса или 1% если линия плоская

        return {
            responsive: false,
            plugins: {
                legend: { display: true },
                title: { display: true, text: title },
            },
            scales: {
                x: {
                    ticks: { maxTicksLimit: 20 },
                    title: { display: true, text: 'Time' }
                },
                y: {
                    beginAtZero: false,
                    suggestedMin: min - margin,
                    suggestedMax: max + margin,
                    ticks: {
                        callback: (value) => value.toLocaleString('en-US')
                    }
                }
            }
        };
    };

    globalThis.chartBankReward = await canvasRenderService.renderToBuffer({
        type: 'line',
        data: { labels, datasets: [datasets.bank_reward] },
        options: buildOptions('Bank Reward ($PX)', values.bank_reward),
    });

    globalThis.chartOnline = await canvasRenderService.renderToBuffer({
        type: 'line',
        data: { labels, datasets: [datasets.current_online] },
        options: buildOptions('Online Users', values.current_online),
    });

    globalThis.chartMintedPixels = await canvasRenderService.renderToBuffer({
        type: 'line',
        data: { labels, datasets: [datasets.minted_pixels] },
        options: buildOptions('Minted Pixels', values.minted_pixels),
    });
}

class Metric {
    constructor(current_online, bank_reward, minted_pixels, ts) {
        this.current_online = current_online;
        this.bank_reward = bank_reward;
        this.minted_pixels = minted_pixels;
        this.ts = ts;
    }
}

const db = SQLite3('db.sqlite')
const insertStmt = db.prepare('INSERT INTO metrics (current_online, bank_reward, minted_pixels, ts) VALUES(@currentOnline, @bankReward, @mintedPixels, @timestamp)')
const selectStmt = db.prepare('SELECT current_online, bank_reward, minted_pixels, ts FROM metrics WHERE ts BETWEEN @start AND @end')
const saveMetrics = (currentOnline, bankReward, mintedPixels) => {
    const params = {
        currentOnline,
        bankReward,
        mintedPixels,
        timestamp: Date.now(),
    }
    insertStmt.run(params)
}

/**
 * 
 * @param {Date} from 
 * @param {Date} to 
 */
const getMetrics = (from, to) => {
    const rows = selectStmt.all({ start: from.getTime(), end: to.getTime() })
    /**@type {Array<Metric>} */
    const resArray = [];
    for (const row of rows) {
        const metric = new Metric(row.current_online, row.bank_reward, row.minted_pixels, row.ts);
        resArray.push(metric);
    }
    return resArray
}

const telegram_app = new Telegraf(process.env.BOT_TOKEN)
const getSeconds = (seconds) => 1000 * seconds;
const getMinutes = (minutes) => getSeconds(60) * minutes;
const getHours = (hours) => getMinutes(60) * hours;

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

telegram_app.command('stats', async (ctx) => {
    await ctx.replyWithMediaGroup([
        { type: 'photo', media: { source: globalThis.chartBankReward }, caption: '🏦 Bank Reward' },
        { type: 'photo', media: { source: globalThis.chartOnline }, caption: '🟢 Online Users' },
        { type: 'photo', media: { source: globalThis.chartMintedPixels }, caption: '🖼 Minted Pixels' },
    ]);
})

setInterval(async () => {
    const [bankInfo, currentUsers, tokenStats] = await Promise.all([
        getBankInfo(),
        getOnlineUsers(),
        getTokenStats(),
    ])

    const lastMinted = mintingHistory.at(-1)?.value ?? 0;
    if (!lastMinted || lastMinted === 0) return;

    saveMetrics(currentUsers, bankInfo, lastMinted)

    const from = new Date(Date.now() - getHours(24));
    const to = new Date();
    const metrics = getMetrics(from, to);

    await renderMetricsCharts(metrics);
}, getMinutes(5));

(async () => {
    startDataCollectiong();
    const from = new Date(Date.now() - getHours(24));
    const to = new Date();
    const metrics = getMetrics(from, to);

    await renderMetricsCharts(metrics)

    telegram_app.use(rateLimit({ window: 1000, limit: 1 }))
    telegram_app.launch()
})()