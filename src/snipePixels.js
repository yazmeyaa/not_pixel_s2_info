import { Address, toNano } from '@ton/core';
import { db } from './db.js'

export class SnipePixel {
    /**
     * 
     * @param {Buffer} target_wallet 
     * @param {Buffer} nft_item_address 
     * @param {number} x 
     * @param {number} y 
     * @param {number} price
     */
    constructor(target_wallet, nft_item_address, x, y, price) {
        this.target_wallet = Address.parse(target_wallet);
        this.nft_item_address = Address.parse(nft_item_address);
        this.x = x;
        this.y = y;
        this.price = price;
    }
}

const insertPixelStmt = db.prepare("INSERT INTO snipe_target_pixel (target_wallet, nft_item_address, x, y, price) VALUES (@targetWallet, @nftItemAddr, @x, @y, @price)");
const getSnipeTargetPixelsStmt = db.prepare("SELECT target_wallet, nft_item_address, price, x, y FROM snipe_target_pixel WHERE target_wallet = @targetWallet AND price=@price AND in_work=0 ORDER BY price DESC LIMIT ? OFFSET ?")
const deletePixelsByAddressStmt = db.prepare("DELETE FROM snipe_target_pixel WHERE target_wallet = @address")
const countPixelsByAddressStmt = db.prepare("SELECT COUNT(target_wallet) as total FROM snipe_target_pixel WHERE target_wallet = @targetWallet AND price = @price AND in_work=0");
const getAllPixelsByAddressStmt = db.prepare("SELECT target_wallet, nft_item_address, price, x, y, in_work FROM snipe_target_pixel WHERE target_wallet = @targetWallet ORDER BY price ASC")
const getPixelsStmt = db.prepare(`
    SELECT target_wallet, nft_item_address, price, x, y
    FROM snipe_target_pixel
    WHERE target_wallet = @targetWallet AND price = @price AND in_work = 0
    LIMIT ?
`);
const countAvailable = db.prepare(`
    SELECT COUNT(nft_item_address) as total
    FROM snipe_target_pixel
    WHERE target_wallet = @targetWallet AND price = @price AND in_work = 0
`)
const lockPixelsBase = (addressPlaceholders) => db.prepare(`
    UPDATE snipe_target_pixel
    SET in_work = 1
    WHERE nft_item_address IN (${addressPlaceholders})
`);

const countPricesStmt = db.prepare(`
    SELECT price, COUNT(*) as count FROM snipe_target_pixel WHERE target_wallet = @targetWallet GROUP BY price`);

/**
 * 
 * @param {import('@ton/core').Address} target
 * @returns {Record<string, number>}
 */
export function countTargetPrices(target) {
    const rows = countPricesStmt.all({ targetWallet: target.toRawString() });
    const result = {};
    for (const row of rows) {
        result[row.price] = row.count;
    }

    return result;
}

/**
 * 
 * @param {import('@ton/core').Address} targetAddr 
 * @param {import('@ton/core').Address} nft 
 * @param {number} x 
 * @param {number} y 
 * @param {number} price
 */
export function saveSnipePixel(targetAddr, nft, x, y, price) {
    insertPixelStmt.run({
        targetWallet: targetAddr.toRawString(),
        nftItemAddr: nft.toRawString(),
        x: x,
        y: y,
        price: price,
    })
}


const buffer = [];
const FLUSH_INTERVAL_MS = 100;

export function queueSavePixel(...args) {
    buffer.push(args);
}

setInterval(() => {
    if (buffer.length === 0) return;

    const batch = buffer.splice(0, buffer.length);
    try {
        const tx = db.transaction(() => {
            for (const args of batch) {
                insertPixelStmt.run(...args);
            }
        });
        tx();
    } catch (err) {
        console.error('DB write failed', err);
    }
}, FLUSH_INTERVAL_MS);

/**
 * 
 * @param {import('@ton/core').Address} targetAddr 
 * @param {number} limit 
 * @param {number} price
 * @param {number} offset
 * @returns {{pixels: SnipePixel[], total: number}}
 */
export function getSnipePixelsByPrice(targetAddr, price, limit, offset) {
    const count = countPixelsByAddressStmt.get({ targetWallet: targetAddr.toRawString(), price: toNano(price) })
    const rows = getSnipeTargetPixelsStmt.all({ targetWallet: targetAddr.toRawString(), price: toNano(price) }, limit, offset);
    const pixels = rows.map(row => {
        return new SnipePixel(row.target_wallet, row.nft_item_address, row.x, row.y, row.price);
    });
    return {
        total: count.total,
        pixels,
    }
}

/**
 * 
 * @param {import('@ton/core').Address} targetAddr 
 */
export function getSnipeAllPixels(targetAddr) {
    const rows = getAllPixelsByAddressStmt.all({ targetWallet: targetAddr.toRawString() })
    return rows.map(row => new SnipePixel(row.target_wallet, row.nft_item_address, row.x, row.y, row.price))
}


/**
 * 
 * @param {import('@ton/core').Address} address 
 */
export function deletePixelsByAddress(address) {
    deletePixelsByAddressStmt.run({ address: address.toRawString() })
}


/**
 * 
 * @param {import('@ton/core').Address} address 
 * @param {number} price 
 * @param {number} limit 
 * @returns {{pixels: SnipePixel[], total: number}}
 */
export function getPixelsByPriceAndLock(address, price, limit) {
    const rawAddress = address.toRawString();
    const pixelsRows = db.transaction(() => {
        const rows = getPixelsStmt.all({ targetWallet: rawAddress, price: toNano(price) }, limit);
        if (rows.length === 0) return { total: 0, rows: [] };

        const addressMap = {};
        const placeholders = rows.map((row, i) => {
            const key = `a${i}`;
            addressMap[key] = row.nft_item_address;
            return `@${key}`;
        }).join(', ');

        lockPixelsBase(placeholders).run(addressMap);
        /** @type {{total: number}} */
        const total = countAvailable.get({ targetWallet: rawAddress, price: toNano(price) })
        return { rows: rows, total: total.total };
    })();

    const { rows, total } = pixelsRows;

    const pixels = rows.map(row =>
        new SnipePixel(row.target_wallet, row.nft_item_address, row.x, row.y, row.price)
    );

    return { pixels, total }
}
