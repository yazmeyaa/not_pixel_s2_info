import { Telegraf } from 'telegraf'

const bot = new Telegraf(process.env.BOT_TOKEN);

const fetchData = async () => {
    const response = await fetch('https://notpixel.org/api/v1/battle-canvas/pixels/filter-info')
    const json = await response.json();
    return json;
}

bot.command('pixels', async (ctx) => {
    const data = await fetchData();
    const prices = data.priceAvailability;

    const text = Object.entries(prices).map(([key, value]) => {
        return `${key} $PX => ${value} pcs.`
    }).join('\n')

    ctx.reply(text);
})

bot.launch();