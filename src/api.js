import { appConfig } from "./config.js";

export const getOnlineUsers = createCache(async () => {
    const res = await fetch('https://notpixel.org/api/v1/history/online/stats');
    return (await res.json()).current_visitors;
}, 1000);
export const getBankInfo = createCache(async () => {
    const res = await fetch('https://notpixel.org/api/v1/battle-canvas/info');
    return (await res.json()).rewardBank;
}, 2000);
export const getTokenStats = createCache(async () => {
    const res = await fetch('https://notpixel.org/api/v1/history/px/stats');
    return await res.json();
}, 2000);

export const getAvailablePixelsCount = createCache(async () => {
    const response = await fetch('https://api.jsonbin.io/v3/b/686856ff8a456b7966bb7eed/latest', {
        headers: new Headers({
            "X-Access-Key": appConfig.jsonBin.accessKey,
        })
    })
    /**@type {{record: Record<string, number>}} */
    const json = await response.json();
    return json.record;
}, 1000 * 60 * 60 * 3)