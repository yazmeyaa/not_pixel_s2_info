import { db } from "./db.js"

const getNotificationChatExpr = db.prepare("SELECT chat_id FROM tournament_notification_reciever")
const addNotificationRecieverExpr = db.prepare(`INSERT OR IGNORE INTO tournament_notification_reciever (chat_id) VALUES(@chatId)`)


/**
 * @returns {{chatId: number}[]}
 */
export const getNotificationChats = () => {
    const rows = getNotificationChatExpr.all();
    return rows.map(x => ({chatId: x.chat_id}));
}

/**
 * 
 * @param {number} chatId 
 */
export const addNotificationReciever = (chatId) => {
    addNotificationRecieverExpr.run({chatId})
}