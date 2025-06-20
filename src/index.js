import { Telegraf } from 'telegraf'
import rateLimit from 'telegraf-ratelimit'
import DB from 'better-sqlite3'

const db = new DB('db.sqlite');
const bot = new Telegraf(process.env.BOT_TOKEN);
const API_URL = 'https://notpixel.org/api/v1/battle-canvas/pixels/filter-info';

const insertRecord = (record) => {
    const ts = Math.floor(Date.now() / 1000);
    const insert = db.prepare('INSERT INTO records (ts, data) VALUES (?, ?)');
    insert.run(ts, JSON.stringify(record));
};

const getRecordsBetweenDates = (date1ts, date2ts) => {
    const rows = db.prepare('SELECT data FROM records WHERE ts BETWEEN ? AND ?').all(date1ts, date2ts)
    console.log(rows);
    return rows;
}

const saveCurrentSnapshot = () => {
    const ts = Math.floor(Date.now() / 1000);
    insertRecord(current);
    previous = { ...current };
    console.log(`[${new Date().toISOString()}] Snapshot saved at ts=${ts}`);
};


let current = {};
let previous = {};

async function fetchData() {
    const response = await fetch(API_URL);
    const json = await response.json();
    return json.priceAvailability;
}

async function startDataSync() {
    try {
        const initial = await fetchData();
        current = initial;
        previous = { ...initial };
    } catch (err) {
        console.error('Initial fetch failed:', err);
        throw err;
    }

    const updateCurrent = async () => {
        try {
            current = await fetchData();
        } catch (err) {
            console.error('Current fetch failed:', err);
        }
    };

    const updatePrevious = () => {
        previous = { ...current };
    };

    const now = new Date();
    const msToNext10s = 10_000 - ((now.getSeconds() % 10) * 1000 + now.getMilliseconds());
    setTimeout(() => {
        updateCurrent();
        setInterval(updateCurrent, 10_000);
    }, msToNext10s);

    const msToNextHour =
        (60 - now.getMinutes()) * 60_000 -
        now.getSeconds() * 1000 -
        now.getMilliseconds();
    setTimeout(() => {
        saveCurrentSnapshot();
        setInterval(saveCurrentSnapshot, 60 * 60_000);
    }, msToNextHour);
}

bot.command('pixels', (ctx) => {
    if (!Object.keys(current).length || !Object.keys(previous).length) {
        return ctx.reply('⏳ Данные еще загружаются...');
    }

    const lines = Object.keys(current).map((key) => {
        const curr = current[key];
        const prev = previous[key] ?? 0;
        const delta = curr - prev;
        const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
        const deltaValue = Math.abs(delta);
        return `${key} $PX => ${curr} pcs. (${sign}${deltaValue} pcs/hour)`;
    });

    ctx.reply(lines.join('\n'));
});

bot.command('stats', (ctx) => {
    const now = new Date();
    const yesterday = new Date();
    yesterday.setDate(now.getDate() - 1);

    const data = getRecordsBetweenDates(yesterday.getTime() / 1000, now.getTime() / 1000);
    console.log(data);

    ctx.reply("OK")
})

/**
 * 
 * @param {number} price 
 * @param {number} limit 
 * @returns {Promise<number[]>}
 */
const getCoordinates = async (price = 1, limit = 10) => {
    const response = await fetch(`https://notpixel.org/api/v1/battle-canvas/pixels/by-price?price=${price}&limit=${limit}`)
    const json = await response.json();

    return json;
}

bot.command('filter', async (ctx) => {
    const price = Number(ctx.args[0] ?? 4);

    const coordsArray = await getCoordinates(price, 10);
    if (coordsArray.length === 0) {
        return ctx.reply(`There is no pixels found with price ${price}$PX`)
    }
    if (price === 1) {
        ctx.reply("Attention!\nFilter by 1$PX may not work correctly.")
    }
    const coords = coordsArray.map(n => {
        const x = (n % 1024) - 1;
        const y = Math.floor(n / 1024);
        return [x, y];
    })

    const linkList = coords.map(([x, y]) => {
        const link = `https://t.me/notpixel/app?startapp=x${x}_y${y}_mbattle`

        return link
    })

    const text = [`${price} $PX pixel links:\n`, ...linkList].join('\n');
    ctx.reply(text);
})

bot.catch(console.error);

(async () => {
    await startDataSync();
    bot.use(rateLimit({ window: 1000, limit: 1 }));
    bot.launch();
})();