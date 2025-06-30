import Bottleneck from "bottleneck";
import { TonApiClient } from '@ton-api/client'
import { appConfig } from './config.js'


const RPS = appConfig.tonapi.rpsLimit;
const minTime = (1000 / RPS);

const limiter = new Bottleneck({ minTime: minTime });
const limitedFetch = limiter.wrap(fetch);

export const tonApiClient = new TonApiClient({
    baseUrl: 'https://tonapi.io',
    apiKey: appConfig.tonapi.apiKey,
    fetch: limitedFetch,
});
