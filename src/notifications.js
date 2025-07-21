import { db } from "./db.js"

const getNotificationChatStmt = db.prepare("SELECT chat_id FROM tournament_notification_reciever")
const addNotificationRecieverStmt = db.prepare(`INSERT OR IGNORE INTO tournament_notification_reciever (chat_id) VALUES(@chatId)`)
const removeNotificationRecieverStmt = db.prepare(`DELETE FROM tournament_notification_reciever WHERE chat_id = @chatId`)


/**
 * @returns {{chatId: number}[]}
 */
export const getNotificationChats = () => {
    const rows = getNotificationChatStmt.all();
    return rows.map(x => ({ chatId: x.chat_id }));
}

/**
 * 
 * @param {number} chatId 
 */
export const addNotificationReciever = (chatId) => {
    addNotificationRecieverStmt.run({ chatId })
}


/**
 * 
 * @param {number} chatId 
 */
export const removeNotificationReciever = (chatId) => {
    removeNotificationRecieverStmt.run({ chatId })
}