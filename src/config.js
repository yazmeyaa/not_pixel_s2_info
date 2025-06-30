import { config } from 'dotenv'
config();

/**
 * 
 * @param {string} key 
 * @param {boolean} required 
 * @param {string} fallback 
 * @returns {string}
 */
const getEnv = (key, required = true, fallback = "") => {
    const value = process.env[key];
    if (!value) {
        if (!required) return fallback;
        throw new Error(`Missed required environment varaible ${key}`);
    }

    return value;
}

export const appConfig = {
    tonapi: {
        apiKey: getEnv("TONAPI_KEY"),
        rpsLimit: parseInt(getEnv("TONAPI_RPS", false, "10"))
    },
    telegram: {
        botToken: getEnv("BOT_TOKEN")
    }
}