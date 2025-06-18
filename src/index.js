import { Telegraf } from 'telegraf'
import rateLimit from 'telegraf-ratelimit'

const bot = new Telegraf(process.env.BOT_TOKEN);
const API_URL = 'https://notpixel.org/api/v1/battle-canvas/pixels/filter-info';

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
        updatePrevious();
        setInterval(updatePrevious, 60 * 60_000); 
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
        const sign = delta >= 0 ? '+' : '';
        return `${key} $PX => ${curr} pcs. (${sign}${delta} pcs/hour)`;
    });

    ctx.reply(lines.join('\n'));
});

bot.catch(console.error);

(async () => {
    await startDataSync();
    bot.use(rateLimit({ window: 1000, limit: 1 }));
    bot.launch();
})();