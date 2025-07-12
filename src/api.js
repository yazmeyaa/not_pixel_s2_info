import { appConfig } from "./config.js";

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


const BIN_ID = '686856ff8a456b7966bb7eed'

export const getAvailablePixelsCount = createCache(async () => {
    const response = await fetch(`https://api.jsonbin.io/v3/b/${BIN_ID}?meta=true`, {
        headers: new Headers({
            "X-Access-Key": appConfig.jsonBin.accessKey,
        })
    })
    /**@type {{record: Record<string, number>}} */
    const json = await response.json();
    const uploadetAtHdrs = response.headers.get('date')
    const uploadetAt = new Date(uploadetAtHdrs);
    return { ...json.record, uploadetAt };
}, 1000 * 60 * 60 * 3)


export const getAvailablePixelsCountNoCache = async () => {
    const response = await fetch(`https://api.jsonbin.io/v3/b/${BIN_ID}?meta=true`, {
        headers: new Headers({
            "X-Access-Key": appConfig.jsonBin.accessKey,
        })
    })
    /**@type {{record: Record<string, number>}} */
    const json = await response.json();
    const uploadetAtHdrs = response.headers.get('date')
    const uploadetAt = new Date(uploadetAtHdrs);
    return { pixels: json.record, uploadetAt };
}
