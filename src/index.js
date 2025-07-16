import { Telegraf } from 'telegraf';
import { Address, fromNano } from '@ton/core';
import { db } from './db.js'
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { saveSnipePixel, getSnipePixelsByPrice, deletePixelsByAddress, getSnipeAllPixels, getPixelsByPriceAndLock, countTargetPrices } from './snipePixels.js';
import { utils, write } from 'xlsx'
import { addUser, addUserAccess, checkAccess, getUserByTelegramID, User } from './user.js';
import rateLimit from 'telegraf-ratelimit'
import { tonApiClient } from './tonapi.js'
import { appConfig } from './config.js';
import { getAvailablePixelsCountNoCache, getBankInfo, getOnlineUsers, getTokenStats } from './api.js'


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
globalThis.chartBankReward = { buffer: null, fileId: null, wasFileUploaded: false };
globalThis.chartOnline = { buffer: null, fileId: null, wasFileUploaded: false };
globalThis.chartMintedPixels = { buffer: null, fileId: null, wasFileUploaded: false };

/**
 * @type {{prev: null | Record<string, number>, current: null | Record<string, number>, uploadetAt: Date | null}}
 */
globalThis.pixelsCount = {
    prev: null,
    current: null,
    uploadetAt: null
}

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
    globalThis.chartBankReward.buffer = await canvasRenderService.renderToBuffer({
        type: 'line',
        data: { labels, datasets: [datasets.bank_reward] },
        options: buildOptions('Bank Reward ($PX)', values.bank_reward),
    });
    globalThis.chartOnline.buffer = await canvasRenderService.renderToBuffer({
        type: 'line',
        data: { labels, datasets: [datasets.current_online] },
        options: buildOptions('Online Users', values.current_online),
    });
    globalThis.chartBankReward.wasFileUploaded = false;
    globalThis.chartOnline.wasFileUploaded = false;
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

/**
 * 
 * @param {string} access 
 * @returns 
 */
const withAccessMiddleware = (access) => {
    return async (ctx, next) => {
        /**@type {User} */
        const user = ctx.state.user
        if (!checkAccess(user, access)) {
            return await ctx.reply("ERR_NO_ACCESS");
        }
        return next();
    }
}



// --- Telegram bot ---
const telegram_app = new Telegraf(appConfig.telegram.botToken);
telegram_app.catch((err) => logError('telegraf', err));

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

function isRealUser(ctx) {
    if (!ctx.from) return false;
    if (ctx.from.is_bot) return false;
    if (ctx.chat && ctx.chat.type === 'channel') return false;
    return true;
}

telegram_app.use((ctx, next) => {
    const isUser = isRealUser(ctx);
    if (isUser) {
        const user = getUserByTelegramID(ctx.from.id);
        ctx.state = ctx.state || {};
        ctx.state.user = user;
        if (!user) {
            console.log(`[${new Date().toLocaleTimeString()}]: User registred. TelegramID: ${ctx.from.id}, Name: ${ctx.from.first_name}`)
            addUser(ctx.from.id);
        }
    }

    return next()
})

const limitOptions = {
    window: 1000,
    limit: 3,
}
telegram_app.use(rateLimit(limitOptions))

telegram_app.start((ctx) => {
    const text = `👋 Welcome to the Not Pixel S2 info bot.

This bot helps you track the current state of the NotPixel game economy, analyze $PX token metrics.

Available commands:
/info – Get current token price, bank size, online players and recent $PX flow.
/stats – Show charts with live data on bank rewards and online user count.
/pixels_stats – View available pixels by price tiers.`

    ctx.reply(text);
})


telegram_app.command('pixels_stats', async (ctx) => {
    const currentPixels = globalThis.pixelsCount.current;
    if (!currentPixels) return;
    const prev = globalThis.pixelsCount.prev;

    const availablePixelsText = Object.entries(currentPixels).map(([key, value]) => {
        const txt = `${key} $PX ~${value} pcs.`;
        if (prev !== null) {
            const delta = currentPixels[key] - prev[key];
            const deltaText = `[${delta > 0 ? `+${delta}` : delta}]`
            return [txt, deltaText].join(' ')
        }

        return txt;
    }).join('\n');

    await Promise.all([
        ctx.react('👍'),
        ctx.reply([
            "Available pixels:\n",
            availablePixelsText,
            '',
            `Updated at: ${globalThis.pixelsCount.uploadetAt.toUTCString()}`
        ].join('\n'))
    ]);
});

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
        `💵 Price PX/USDT: $${tokenStats.price.toFixed(3)}`,
        `💰 Tournament Bank: ${bankInfo.toLocaleString('en-US')} $PX (~${(bankInfo * tokenStats.price).toLocaleString('en-US')}$)`,
        `📊 Bank change:\n${deltaLines.join('\n')}\n`,
        `🔥 Pixels to burn ${toBurn.toLocaleString('en-US')} $PX🔥`,
        `🟢 Online users: ${currentUsers.toLocaleString('en-US')}`
    ].join('\n'));
}));

telegram_app.command('stats', ctx => catchError('tg:stats', async () => {
    if (!globalThis.chartBankReward.wasFileUploaded || !global.chartOnline.wasFileUploaded) {
        const [bankMedia, onlineMedia] = await ctx.replyWithMediaGroup([
            { type: 'photo', media: { source: globalThis.chartBankReward.buffer }, caption: '🏦 Bank Reward' },
            { type: 'photo', media: { source: globalThis.chartOnline.buffer }, caption: '🟢 Online Users' },
        ])

        if ('photo' in bankMedia) {
            const fullsizePhoto = bankMedia.photo.find(photo => {
                return photo.width === 800 && photo.height === 400;
            })
            if (!fullsizePhoto) return;
            globalThis.chartBankReward.fileId = fullsizePhoto.file_id;
            globalThis.chartBankReward.wasFileUploaded = true;
        }

        if ('photo' in onlineMedia) {
            const fullsizePhoto = onlineMedia.photo.find(photo => {
                return photo.width === 800 && photo.height === 400;
            })
            if (!fullsizePhoto) return;
            globalThis.chartOnline.fileId = fullsizePhoto.file_id;
            globalThis.chartOnline.wasFileUploaded = true;
        }


        return
    }
    else {
        await ctx.replyWithMediaGroup([
            { type: 'photo', media: globalThis.chartBankReward.fileId, caption: '🏦 Bank Reward' },
            { type: 'photo', media: globalThis.chartOnline.fileId, caption: '🟢 Online Users' },
        ]);
    }
}));

telegram_app.command('snipe_xlsx', withAccessMiddleware('snipe'), async (ctx) => {
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

    const nfts = getSnipeAllPixels(addr);

    if (!nfts || nfts.length === 0) {
        return await ctx.reply('Empty list');
    }

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

telegram_app.command('add_access', withAccessMiddleware('access_management'), async (ctx) => {
    const target = ctx.message.reply_to_message.from.id;
    if (ctx.args.length < 1) {
        return await ctx.reply('missed ACCESS argument');
    }
    const access = ctx.args[0];
    if (!target) {
        return await ctx.reply('missed reply target');
    }
    let targetUser = getUserByTelegramID(target);
    if (!targetUser) {
        addUser(target);
        targetUser = getUserByTelegramID(target);
    }
    addUserAccess(targetUser, access);
    return await ctx.reply('OK!')
})

telegram_app.command('snipe', withAccessMiddleware('snipe'), async (ctx) => {
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
const NOT_PIXEL_NFT_COLLECTION_ADDRESS = Address.parse('EQDxPnc-hOZTW5pxFFt56pny-W3UuEs7ktzf-tAGNCkxtOl1');

async function collectNfts(targetAddr, chatId) {
    const startTime = Date.now();
    let offset = 0;
    let savedCount = 0;

    const PAGE_LIMIT = 100;

    while (true) {
        try {
            const nfts = await tonApiClient.accounts.getAccountNftItems(targetAddr, {
                collection: NOT_PIXEL_NFT_COLLECTION_ADDRESS,
                limit: PAGE_LIMIT,
                offset
            });

            if (nfts.nftItems.length === 0) break;

            await Promise.all(nfts.nftItems.map(async (nft) => {
                try {
                    const attrs = nft.metadata?.attributes || [];
                    const x = attrs.find(attr => attr.trait_type === 'X')?.value;
                    const y = attrs.find(attr => attr.trait_type === 'Y')?.value;

                    if (x && y) {
                        const balances = await tonApiClient.accounts.getAccountJettonsBalances(nft.address);
                        const px = balances?.balances?.find(b => b.jetton.address.equals(NOT_PIXEL_JETTON_ADDRESS));
                        let pxBalance = px?.balance ?? BigInt(1e9);

                        if (pxBalance === BigInt(1e9)) {
                            pxBalance = BigInt(2e9);
                        } else {
                            pxBalance = 4n * (pxBalance + BigInt(0.5e9));
                        }

                        saveSnipePixel(targetAddr, nft.address, x, y, pxBalance);
                        savedCount++;
                    }
                } catch (err) {
                    logError('collectNfts.item', err);
                }
            }));
            const now = new Date();
            console.log(`[${now.toLocaleTimeString()}]: Processed ${nfts.nftItems.length} pixels. Go next.`);

            offset += PAGE_LIMIT;
        } catch (error) {
            logError('collectNfts', error);
            telegram_app.telegram.sendMessage(chatId, `Failed to collect user NFTS.`);
            telegram_app.telegram.sendMessage("279603779", error.message);
            break;
        }
    }

    const durationMs = Date.now() - startTime;
    const durationStr = formatDuration(durationMs);

    await telegram_app.telegram.sendMessage(chatId, `✅ Done.\nSaved ${savedCount} pixels in ${durationStr}.`);
}

telegram_app.command('snipe_stats', withAccessMiddleware('snipe'), async (ctx) => {
    if (ctx.args.length < 1) {
        return await ctx.reply('/snipe_stats {address}')
    }

    const targetAddr = ctx.args[0]
    /**@type {import('@ton/core').Address | null} */
    let addr = null;
    try {
        addr = Address.parse(targetAddr);
    }
    catch (error) {
        await ctx.reply('Wrong address');
    }

    const result = countTargetPrices(addr);
    if (Object.keys(result).length === 0) {
        return await ctx.reply("Empty list.")
    }

    const replyMsg = Object.entries(result).map(([key, value]) => `${fromNano(key)} $PX: ${value} pixels`).join('\n');
    return await ctx.reply(replyMsg);

})

telegram_app.command('take', withAccessMiddleware('snipe'), async (ctx) => {
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

let activeCollectProcesses = 0;
const pendingConfirmations = new Map();

telegram_app.command('collect', withAccessMiddleware('snipe'), async (ctx) => {
    if (ctx.args.length < 1) return await ctx.reply('Target address is missing');
    const targetAddr = Address.parse(ctx.args[0]);

    if (activeCollectProcesses > 0) {
        // Сохраняем в Map по chatId
        pendingConfirmations.set(ctx.chat.id, { ctx, targetAddr });

        await ctx.reply(
            `⚠️ There are already ${activeCollectProcesses} active processes. Are you sure you want to start another one?`,
            {
                reply_markup: {
                    inline_keyboard: [[
                        { text: "Yes, proceed", callback_data: `confirm_collect:${ctx.chat.id}` },
                        { text: "Cancel", callback_data: `cancel_collect:${ctx.chat.id}` }
                    ]]
                }
            }
        );
        return;
    }

    await startCollect(targetAddr, ctx);
});

async function startCollect(targetAddr, ctx) {
    activeCollectProcesses++;
    deletePixelsByAddress(targetAddr);

    await Promise.all([
        ctx.react?.('👍'),
        ctx.reply?.(`Started processing wallet ${targetAddr.toString()}...`)
    ]);

    setImmediate(() => collectNfts(targetAddr, ctx.chat.id)
        .catch(err => logError('collect', err))
        .finally(() => {
            activeCollectProcesses--;
        }));
}

telegram_app.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [action, chatIdStr] = data.split(':');
    const chatId = parseInt(chatIdStr);

    const pending = pendingConfirmations.get(chatId);

    if (action === 'confirm_collect') {
        if (!pending) {
            await ctx.answerCbQuery("Confirmation expired.");
            return;
        }

        await ctx.editMessageText(`✅ Collection confirmed for ${pending.targetAddr.toString()}`);
        pendingConfirmations.delete(chatId);

        await startCollect(pending.targetAddr, pending.ctx);
    }

    if (action === 'cancel_collect') {
        pendingConfirmations.delete(chatId);
        await ctx.editMessageText("❌ Collection canceled.");
    }

    await ctx.answerCbQuery();
});


telegram_app.command('collect', withAccessMiddleware('snipe'), async (ctx) => {
    if (ctx.args.length < 1) return await ctx.reply('Missed target address');
    const targetAddr = Address.parse(ctx.args[0]);
    deletePixelsByAddress(targetAddr);

    await Promise.all([
        ctx.react('👍'),
        ctx.reply(`Start processing wallet ${ctx.args[0]}...`)
    ]);

    setImmediate(() => collectNfts(targetAddr, ctx.chat.id).catch(err => {
        logError('collect', err);
    }));
});

setInterval(async () => {
    const pixels = await getAvailablePixelsCountNoCache()
    globalThis.pixelsCount.prev = globalThis.pixelsCount.current;
    globalThis.pixelsCount.current = pixels.pixels;
    globalThis.pixelsCount.uploadetAt = pixels.uploadetAt;
}, 1000 * 60 * 30)

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
        const pixels = await getAvailablePixelsCountNoCache();
        globalThis.pixelsCount.current = pixels.pixels;
        globalThis.pixelsCount.uploadetAt = pixels.uploadetAt;

        const bankInfo = await getBankInfo()
        updateSnapshots(bankInfo);

        const metrics = getMetrics(new Date(Date.now() - getHours(24)), new Date());
        await renderMetricsCharts(metrics);

        telegram_app.launch();
    });
})();
