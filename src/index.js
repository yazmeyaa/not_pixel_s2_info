import { Telegraf } from 'telegraf'
import rateLimit from 'telegraf-ratelimit'

const bot = new Telegraf(process.env.BOT_TOKEN);

const API_URL = 'https://notpixel.org/api/v1/battle-canvas/pixels/filter-info';


let current = {};
let previous = {};

async function startDataSync() {
    try {
        const response = await fetch(API_URL);
        const json = await response.json();
        current = json.priceAvailability;
        previous = { ...current };
    } catch (err) {
        console.error('Initial fetch failed:', err);
        throw err;
    }

    const sync = async () => {
        try {
            const response = await fetch(API_URL);
            const json = await response.json();
            previous = current;
            current = json.priceAvailability;
        } catch (err) {
            console.error('Scheduled fetch failed:', err);
        }
    };

    const now = new Date();
    const msUntilNextSlot = 10_000 - ((now.getSeconds() % 10) * 1000 + now.getMilliseconds());

    setTimeout(() => {
        sync();
        setInterval(sync, 10_000);
    }, msUntilNextSlot);
}


bot.command('pixels', (ctx) => {
    if (!Object.keys(current).length || !Object.keys(previous).length) {
        return ctx.reply('⏳ Данные еще загружаются...');
    }

    const lines = Object.keys(current).map(key => {
        const curr = current[key];
        const prev = previous[key] ?? 0;
        const delta = curr - prev;
        const sign = delta >= 0 ? '+' : '';
        return `${key} $PX => ${curr} pcs. (${sign}${delta} pcs/min)`;
    });

    ctx.reply(lines.join('\n'));
});

bot.catch((err) => {
    console.error(err)
})

startDataSync();
bot.use(rateLimit({ window: 1000, limit: 1 }));
bot.launch();
