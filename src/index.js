import { Telegraf } from 'telegraf';
import { TonApiClient } from '@ton-api/client';
import { Address, fromNano } from '@ton/core';
import { db } from './db.js'
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { saveSnipePixel, getSnipePixelsByPrice, deletePixelsByAddress, getSnipeAllPixels, getPixelsByPriceAndLock } from './snipePixels.js';
import Bottleneck from 'bottleneck';
import { utils, write } from 'xlsx'

// --- Global Error Handling ---
function logError(tag, error, extra = {}) {
    const ts = new Date().toISOString();
    const errObj = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { error };
    console.error(`[${ts}] [${tag}]`, { ...errObj, ...extra });
}
async function catchError(tag, fn) {
    try {
        return await fn();
    } catch (error) {
        logError(tag, error);
    }
}
process.on('unhandledRejection', (reason) => logError('unhandledRejection', reason));
process.on('uncaughtException', (err) => logError('uncaughtException', err));

// --- Globals ---
globalThis.chartBankReward = null;
globalThis.chartOnline = null;
globalThis.chartMintedPixels = null;

// --- Chart rendering ---
const width = 800;
const height = 400;
const canvasRenderService = new ChartJSNodeCanvas({
    width,
    height,
    chartCallback: (ChartJS) => {
        ChartJS.defaults.font.family = 'Arial';
        ChartJS.defaults.font.size = 12;
    },
});
async function renderMetricsCharts(metrics) {
    const labels = metrics.map(m => new Date(m.ts).toLocaleTimeString('en-US', { hour12: false }));
    const values = {
        bank_reward: metrics.map(m => m.bank_reward),
        current_online: metrics.map(m => m.current_online),
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
    };
    const buildOptions = (title, dataArray) => {
        const min = Math.min(...dataArray);
        const max = Math.max(...dataArray);
        const delta = max - min;
        const margin = delta > 0 ? delta * 0.1 : max * 0.01;
        return {
            responsive: false,
            plugins: { legend: { display: true }, title: { display: true, text: title } },
            scales: {
                x: { ticks: { maxTicksLimit: 20 }, title: { display: true, text: 'Time' } },
                y: {
                    beginAtZero: false,
                    suggestedMin: min - margin,
                    suggestedMax: max + margin,
                    ticks: { callback: value => value.toLocaleString('en-US') },
                },
            },
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
}

// --- DB ---
class Metric {
    constructor(current_online, bank_reward, minted_pixels, ts) {
        this.current_online = current_online;
        this.bank_reward = bank_reward;
        this.minted_pixels = minted_pixels;
        this.ts = ts;
    }
}
const insertStmt = db.prepare('INSERT INTO metrics (current_online, bank_reward, ts) VALUES(@currentOnline, @bankReward, @timestamp)');
const selectStmt = db.prepare('SELECT current_online, bank_reward, ts FROM metrics WHERE ts BETWEEN @start AND @end');
function saveMetrics(currentOnline, bankReward) {
    try {
        insertStmt.run({
            currentOnline,
            bankReward,
            timestamp: Date.now(),
        });
    } catch (err) {
        logError('db:insert', err);
    }
}
function getMetrics(from, to) {
    const rows = selectStmt.all({ start: from.getTime(), end: to.getTime() });
    return rows.map(row => new Metric(row.current_online, row.bank_reward, row.minted_pixels, row.ts));
}

// --- Time helpers ---
const getSeconds = (s) => 1000 * s;
const getMinutes = (m) => getSeconds(60) * m;
const getHours = (h) => getMinutes(60) * h;

const RPS = process.env.TONAPI_RPS ?? 10;
const minTime = (1000 / RPS) + 5;

const limiter = new Bottleneck({ minTime: minTime, maxConcurrent: 1 });
const limitedFetch = limiter.wrap(fetch);

const ta = new TonApiClient({
    baseUrl: 'https://tonapi.io',
    apiKey: 'AFRANRCCXL2DBDIAAAAFEVPZWRHEDNYD43O2J43MNTSEC7XDP44AIWH53JQGVPBQEMRCS7I',
    fetch: limitedFetch,
});

// --- Data fetching with cache ---й
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

// --- Telegram bot ---
const telegram_app = new Telegraf(process.env.BOT_TOKEN);
telegram_app.catch((err, ctx) => logError('telegraf', err));

const bankSnapshots = [];

function updateSnapshots(currentValue) {
    const now = Date.now();
    bankSnapshots.push({ timestamp: now, value: currentValue });

    const retentionWindow = 120 * 60 * 1000;
    const cutoff = now - retentionWindow;
    while (bankSnapshots.length > 0 && bankSnapshots[0].timestamp < cutoff) {
        bankSnapshots.shift();
    }
}

function getDelta(durationMs, currentValue) {
    const targetTs = Date.now() - durationMs;
    const snapshot = [...bankSnapshots]
        .reverse()
        .find(snap => snap.timestamp <= targetTs);

    if (!snapshot) return null;

    const delta = currentValue - snapshot.value;
    const percent = ((delta / snapshot.value) * 100);
    return { delta, percent };
}

// --- Commands ---
telegram_app.command('info', ctx => catchError('tg:info', async () => {
    const [bankInfo, currentUsers, tokenStats] = await Promise.all([
        getBankInfo(),
        getOnlineUsers(),
        getTokenStats(),
    ]);

    const deltas = [
        { label: '10m', result: getDelta(10 * 60 * 1000, bankInfo) },
        { label: '30m', result: getDelta(30 * 60 * 1000, bankInfo) },
        { label: '1h', result: getDelta(60 * 60 * 1000, bankInfo) },
    ];

    const deltaLines = deltas.map(({ label, result }) => {
        if (!result) return `↔️ No data for ${label}`;
        const arrow = result.delta > 0 ? '📈' : result.delta < 0 ? '📉' : '➖';
        return `${arrow} ${label}: ${result.delta.toLocaleString('en-US')} PX (${result.percent.toFixed(2)}%)`;
    });

    const toBurn = ((bankInfo - 1_000_000) / 2);
    await ctx.react('👍');
    await ctx.reply([
        `💰 Tournament Bank: ${bankInfo.toLocaleString('en-US')} $PX (~${(bankInfo * tokenStats.price).toLocaleString('en-US')}$)`,
        `📊 Bank change:\n${deltaLines.join('\n')}\n`,
        `🔥Pixels to burn ${toBurn.toLocaleString('en-US')} $PX🔥`,
        `🟢 Online users: ${currentUsers.toLocaleString('en-US')}`
    ].join('\n'));
}));

telegram_app.command('stats', ctx => catchError('tg:stats', async () => {
    await ctx.replyWithMediaGroup([
        { type: 'photo', media: { source: globalThis.chartBankReward }, caption: '🏦 Bank Reward' },
        { type: 'photo', media: { source: globalThis.chartOnline }, caption: '🟢 Online Users' },
    ]);
}));

telegram_app.command('snipe_xlsx', async (ctx) => {
    if (ctx.args.length < 1) {
        return await ctx.reply('Target address is missing');
    }

    let addr;
    try {
        addr = Address.parse(ctx.args[0]);
    } catch (error) {
        logError('snipe_xlsx', error);
        return await ctx.reply('Wrong address');
    }

    const nfts = getSnipeAllPixels(addr); // Предположим, sync fn. Если async — добавь await.

    if (!nfts || nfts.length === 0) {
        return await ctx.reply('Empty list');
    }

    // Колонки в нужном порядке
    const headers = ['Цена (PX)', 'Адрес NFT', 'X', 'Y', 'Ссылка'];
    const fieldMap = {
        'Цена (PX)': r => fromNano(r.price),
        'Адрес NFT': r => r.nft_item_address.toString(),
        'X': r => r.x,
        'Y': r => r.y,
        'Ссылка': r => `https://t.me/notpixel/app?startapp=x${r.x}_y${r.y}_mbattle`,
    };

    const rows = nfts.map(record =>
        Object.fromEntries(headers.map(h => [h, fieldMap[h](record)]))
    );

    const worksheet = utils.json_to_sheet(rows, { header: headers });

    worksheet['!cols'] = headers.map(h => {
        const maxLen = Math.max(
            h.length,
            ...rows.map(row => String(row[h] ?? '').length)
        );
        return { wch: maxLen + 2 };
    });

    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, worksheet, 'pixels');

    const buffer = write(workbook, { type: 'buffer', bookType: 'xlsx' });

    const shortAddr = [addr.toRawString().slice(0, 5), addr.toRawString().slice(-5, -1)].join('...');
    await ctx.replyWithDocument({ source: buffer, filename: `${shortAddr}.xlsx` });
});

telegram_app.command('snipe', async (ctx) => {
    if (ctx.args.length < 3) return await ctx.reply('Wrong command usage\n/snipe {address} {price} {page} {page_size}');
    const targetAddress = Address.parse(ctx.args[0]);
    const price = parseInt(ctx.args[1]);
    const page = parseInt(ctx.args[2]);
    const perPage = parseInt(ctx.args[3]);

    try {
        const { pixels: nfts, total } = getSnipePixelsByPrice(targetAddress, price, perPage, (page - 1) * perPage);
        if (nfts.length < 1) {
            return await ctx.reply('Empty list.')
        }
        const header = `Page ${page}/${Math.ceil(total / perPage)}:\n`
        let offset = header.length + 1;
        const response = nfts.reduce((acc, curr, idx) => {
            const text = `${idx + 1}. [x: ${curr.x}; y: ${curr.y}] - ${fromNano(curr.price)} $PX`;
            acc.entities.push({ type: "text_link", url: `https://t.me/notpixel/app?startapp=x${curr.x}_y${curr.y}_mbattle`, offset, length: text.length });
            acc.strings.push(text);
            offset += text.length + 1;
            return acc;
        }, { entities: [], strings: [] });

        await ctx.reply([header, ...response.strings].join('\n'), {
            link_preview_options: { is_disabled: true },
            entities: response.entities,
        });
    } catch (error) {
        logError('snipe', error);
        await ctx.reply(error.message);
    }
});

function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return `${hours.toString().padStart(2, '0')}:` +
        `${minutes.toString().padStart(2, '0')}:` +
        `${seconds.toString().padStart(2, '0')}`;
}


const NOT_PIXEL_JETTON_ADDRESS = Address.parse('EQB420yQsZobGcy0VYDfSKHpG2QQlw-j1f_tPu1J488I__PX');

async function collectNfts(targetAddr, chatId) {
    const startTime = Date.now();
    let offset = 0;
    let savedCount = 0;
    let stopLogging = false;

    const collectionAddr = Address.parse('EQDxPnc-hOZTW5pxFFt56pny-W3UuEs7ktzf-tAGNCkxtOl1');

    const progressMsg = await telegram_app.telegram.sendMessage(chatId, `Saved 0 pixels...`);
    const messageId = progressMsg.message_id;

    const updateProgress = async () => {
        while (!stopLogging) {
            await new Promise(res => setTimeout(res, 3000));
            try {
                await telegram_app.telegram.editMessageText(chatId, messageId, undefined, `Saved ${savedCount} pixels...`);
            } catch (_) { }
        }
    };
    updateProgress();

    while (true) {
        const nfts = await ta.accounts.getAccountNftItems(targetAddr, {
            collection: collectionAddr,
            limit: 1000,
            offset
        });

        if (nfts.nftItems.length === 0) break;

        for (let i = 0; i < nfts.nftItems.length; i += 10) {
            const batch = nfts.nftItems.slice(i, i + 10);
            await Promise.all(batch.map(async (nft) => {
                const attrs = nft.metadata?.attributes || [];
                const x = attrs.find(attr => attr.trait_type === 'X')?.value;
                const y = attrs.find(attr => attr.trait_type === 'Y')?.value;

                if (x && y) {
                    const balances = await ta.accounts.getAccountJettonsBalances(nft.address);
                    let pxBalance = balances.balances.find(b => b.jetton.address.equals(NOT_PIXEL_JETTON_ADDRESS))?.balance || BigInt(1e9);

                    if (pxBalance === BigInt(1e9)) {
                        pxBalance = 2e9;
                    } else {
                        pxBalance = 4n * (pxBalance + BigInt(0.5e9));
                    }

                    saveSnipePixel(targetAddr, nft.address, x, y, pxBalance);
                    savedCount++;
                }
            }));
        }

        offset += 1000;
    }

    stopLogging = true;

    const durationMs = Date.now() - startTime;
    const durationStr = formatDuration(durationMs);

    await telegram_app.telegram.sendMessage(chatId, `✅ Done.\nSaved ${savedCount} pixels in ${durationStr}.`);
}


telegram_app.command('take', async (ctx) => {
    if (ctx.args.length < 3) {
        return await ctx.reply('/take {address} {price} {count}')
    }
    const targetAddress = ctx.args[0];
    const price = parseInt(ctx.args[1]);
    const count = parseInt(ctx.args[2]);

    const target = Address.parse(targetAddress);

    const { pixels: nfts, total } = getPixelsByPriceAndLock(target, price, count);
    if (nfts.length === 0) {
        return await ctx.reply("Empty list.")
    }

    let offset = 0;
    const response = nfts.reduce((acc, curr, idx) => {
        const text = `${idx + 1}. [x: ${curr.x}; y: ${curr.y}] - ${fromNano(curr.price)} $PX`;
        acc.entities.push({ type: "text_link", url: `https://t.me/notpixel/app?startapp=x${curr.x}_y${curr.y}_mbattle`, offset, length: text.length });
        acc.strings.push(text);
        offset += text.length + 1;
        return acc;
    }, { entities: [], strings: [] });

    await ctx.reply([response.strings.join('\n'), '\n', `Left ${total} pixels with price ${price} $PX.`].join('\n'), {
        link_preview_options: { is_disabled: true },
        entities: response.entities,
    });
})

telegram_app.command('collect', async (ctx) => {
    if (ctx.args.length < 1) return await ctx.reply('Missed target address');
    const targetAddr = Address.parse(ctx.args[0]);
    deletePixelsByAddress(targetAddr);

    await Promise.all([
        ctx.react('👍'),
        ctx.reply('Start processing wallet...')
    ]);

    setImmediate(() => collectNfts(targetAddr, ctx.chat.id).catch(err => {
        logError('collect', err);
    }));
});

// --- Metrics Polling ---
setInterval(() => catchError('metrics-collector', async () => {
    const [bankInfo, currentUsers] = await Promise.all([getBankInfo(), getOnlineUsers()]);
    saveMetrics(currentUsers, bankInfo);
    const metrics = getMetrics(new Date(Date.now() - getHours(24)), new Date());
    await renderMetricsCharts(metrics);
}), getMinutes(5));

setInterval(async () => {
    const bankInfo = await getBankInfo()
    updateSnapshots(bankInfo);
}, getSeconds(10));

// --- Startup ---
(async () => {
    await catchError('startup', async () => {
        const bankInfo = await getBankInfo()
        updateSnapshots(bankInfo);
        const metrics = getMetrics(new Date(Date.now() - getHours(24)), new Date());
        await renderMetricsCharts(metrics);
        telegram_app.launch();
    });
})();