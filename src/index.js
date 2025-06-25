// Centralized error logging
function logError(tag, error, extra = {}) {
    const ts = new Date().toISOString();
    const errObj = (error instanceof Error)
        ? { name: error.name, message: error.message, stack: error.stack }
        : { error };
    console.error(`[${ts}] [${tag}]`, { ...errObj, ...extra });
}

async function catchError(tag, fn) {
    try {
        return await fn();
    } catch (error) {
        logError(tag, error);
    }
}

process.on('unhandledRejection', (reason, p) => {
    logError('unhandledRejection', reason);
});

process.on('uncaughtException', (err) => {
    logError('uncaughtException', err);
});

import { Telegraf } from 'telegraf';
import rateLimit from 'telegraf-ratelimit';
import { TonApiClient } from '@ton-api/client';
import { Address } from '@ton/core';
import SQLite3 from 'better-sqlite3';
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
        const margin = delta > 0 ? delta * 0.1 : max * 0.01;

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

const db = SQLite3('db.sqlite');
const insertStmt = db.prepare('INSERT INTO metrics (current_online, bank_reward, minted_pixels, ts) VALUES(@currentOnline, @bankReward, @mintedPixels, @timestamp)');
const selectStmt = db.prepare('SELECT current_online, bank_reward, minted_pixels, ts FROM metrics WHERE ts BETWEEN @start AND @end');

function saveMetrics(currentOnline, bankReward, mintedPixels) {
    const params = {
        currentOnline,
        bankReward,
        mintedPixels,
        timestamp: Date.now(),
    };
    try {
        insertStmt.run(params);
    } catch (err) {
        logError('db:insert', err, params);
    }
}

function getMetrics(from, to) {
    const rows = selectStmt.all({ start: from.getTime(), end: to.getTime() });
    const resArray = rows.map(row => new Metric(row.current_online, row.bank_reward, row.minted_pixels, row.ts));
    return resArray;
}

const telegram_app = new Telegraf(process.env.BOT_TOKEN);
const getSeconds = (s) => 1000 * s;
const getMinutes = (m) => getSeconds(60) * m;
const getHours = (h) => getMinutes(60) * h;

telegram_app.catch((err, ctx) => logError('telegraf', err));

function createCache(fn, ttlMs) {
    let cache = null;
    let cacheTime = 0;
    return async () => {
        const now = Date.now();
        if (cache && now - cacheTime < ttlMs) return cache;
        cache = await fn();
        cacheTime = now;
        return cache;
    };
}

const ta = new TonApiClient({
    baseUrl: 'https://tonapi.io',
    apiKey: 'AFRANRCC2VJQ4MQAAAAHZJVF7PB2B5YNVM4GNUJI6VAMNS3VSCVPXSQK5E3DGG3UPDC6CEQ'
});
const collectionAddress = Address.parse('EQDxPnc-hOZTW5pxFFt56pny-W3UuEs7ktzf-tAGNCkxtOl1');

const mintingHistory = [];
function getMintedInLast(minutes) {
    const cutoff = Date.now() - getMinutes(minutes);
    const relevant = mintingHistory.filter(e => e.time >= cutoff);
    if (!relevant.length) return 0;
    return relevant.at(-1).value - relevant[0].value;
}

const startDataCollectiong = async () => {
    setInterval(() => catchError('mint-history', async () => {
        const collection = await ta.nft.getNftCollection(collectionAddress);
        mintingHistory.push({ time: Date.now(), value: collection.nextItemIndex });
        const cutoff = Date.now() - getMinutes(60);
        while (mintingHistory.length && mintingHistory[0].time < cutoff) {
            mintingHistory.shift();
        }
    }), getSeconds(2));
};

const getOnlineUsers = createCache(async () => {
    const res = await fetch('https://notpixel.org/api/v1/history/online/stats');
    return (await res.json()).current_visitors;
}, 1000);

const getBankInfo = createCache(async () => {
    const res = await fetch('https://notpixel.org/api/v1/battle-canvas/info');
    return (await res.json()).rewardBank;
}, 2000);

const getTokenStats = createCache(async () => {
    const res = await fetch('https://notpixel.org/api/v1/history/px/stats');
    return await res.json();
}, 2000);

telegram_app.command('info', ctx => catchError('tg:info', async () => {
    const [bankInfo, currentUsers, tokenStats] = await Promise.all([
        getBankInfo(),
        getOnlineUsers(),
        getTokenStats(),
    ]);
    const total = 1024 ** 2;
    const latest = mintingHistory.at(-1)?.value ?? 0;
    const percentage = (latest / total) * 100;
    const left = (total - latest) - 1;
    console.log(left)

    await ctx.react('👍');

    const replyResult = [];
    replyResult.push(`💰 Tournament Bank: ${bankInfo.toLocaleString('en-US')} $PX (~${(bankInfo * tokenStats.price).toLocaleString('en-US')}$)\n`)
    if (left > 0) {
        replyResult.push(`Pixels to mint left: ${left.toLocaleString('en-US')}◾️`)
    }
    replyResult.push(`Total pixels: ${total.toLocaleString('en-US')}◾️`)
    replyResult.push(`Minted: ${percentage.toFixed(2)}%\n`)

    if (left > 0) {
        replyResult.push(`Minted in 5m: ${getMintedInLast(5).toLocaleString('en-US')}◾️`)
        replyResult.push(`Minted in 10m: ${getMintedInLast(10).toLocaleString('en-US')}◾️`)
        replyResult.push(`Minted in 30m: ${getMintedInLast(30).toLocaleString('en-US')}◾️`)
        replyResult.push(`Minted in 60m: ${getMintedInLast(60).toLocaleString('en-US')}◾️\n`)
    }
    replyResult.push(`🟢 Online users: ${currentUsers.toLocaleString('en-US')}`)

    await ctx.reply(replyResult.join('\n'));
}));

telegram_app.command('stats', ctx => catchError('tg:stats', async () => {
    await ctx.replyWithMediaGroup([
        { type: 'photo', media: { source: globalThis.chartBankReward }, caption: '🏦 Bank Reward' },
        { type: 'photo', media: { source: globalThis.chartOnline }, caption: '🟢 Online Users' },
        { type: 'photo', media: { source: globalThis.chartMintedPixels }, caption: '🖼 Minted Pixels' },
    ]);
}));

setInterval(() => catchError('metrics-collector', async () => {
    const [bankInfo, currentUsers] = await Promise.all([
        getBankInfo(),
        getOnlineUsers(),
    ]);
    const lastMinted = mintingHistory.at(-1)?.value ?? 0;
    saveMetrics(currentUsers, bankInfo, lastMinted);
    const metrics = getMetrics(new Date(Date.now() - getHours(24)), new Date());
    await renderMetricsCharts(metrics);
}), getMinutes(5));

(async () => {
    await catchError('startup', async () => {
        await startDataCollectiong();
        const metrics = getMetrics(new Date(Date.now() - getHours(24)), new Date());
        await renderMetricsCharts(metrics);
        telegram_app.use(rateLimit({ window: 1000, limit: 1 }));
        telegram_app.launch();
    });
})();
