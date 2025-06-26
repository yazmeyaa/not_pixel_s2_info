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
const getSnipeTargetPixelsStmt = db.prepare("SELECT target_wallet, nft_item_address, price, x, y FROM snipe_target_pixel WHERE target_wallet = @targetWallet AND price=@price ORDER BY price DESC LIMIT ? OFFSET ?")
const deletePixelsByAddressStmt = db.prepare("DELETE FROM snipe_target_pixel WHERE target_wallet = @address")

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

/**
 * 
 * @param {import('@ton/core').Address} targetAddr 
 * @param {number} limit 
 * @param {number} price
 * @param {number} offset
 * @returns {SnipePixel[]}
 */
export function getSnipePixels(targetAddr, price, limit, offset) {
    console.log(toNano(price));
    const rows = getSnipeTargetPixelsStmt.all({ targetWallet: targetAddr.toRawString(), price: toNano(price) }, limit, offset);
    return rows.map(row => {
        return new SnipePixel(row.target_wallet, row.nft_item_address, row.x, row.y, row.price);
    });
}

/**
 * 
 * @param {import('@ton/core').Address} address 
 */
export function deletePixelsByAddress(address) {
    deletePixelsByAddressStmt.run({ address: address.toRawString() })
}