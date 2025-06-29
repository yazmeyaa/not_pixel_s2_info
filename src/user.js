import { db } from './db.js'

export class User {
    /**
     * 
     * @param {number} id 
     * @param {number} telegramID 
     */
    constructor(id, telegramID) {
        this.id = id;
        this.telegramID = telegramID;
    }
}

const addUserStmt = db.prepare(`
    INSERT INTO user(telegram_id) VALUES(@telegramID);
`);

const addUserAccessStmt = db.prepare(`
    INSERT INTO user_access(user_id, access_to) VALUES(@userID, @accessTo)`);

const removeUserAccessStmt = db.prepare(`
    DELETE FROM user_access WHERE user_id = @userID AND access_to = @accessTo    
`);

const flushAllAccessStmt = db.prepare(`
    DELETE FROM user_access WHERE user_id = @user_id
`);

const getUserByTelegramIDStmt = db.prepare(`
    SELECT id, telegram_id FROM user WHERE telegram_id = @telegramID
`);

const userHasAccessToStmt = db.prepare(`
    SELECT COUNT(*) as result FROM user_access WHERE user_id = @userID AND access_to = @accessTo
`);

const getUserAccessListStmt = db.prepare(`
    SELECT user_id, access_to FROM user_access WHERE user_id = @userID    
`)


/**
 * 
 * @param {number} telegramID 
 */

export function addUser(telegramID) {
    addUserStmt.run({ telegramID })
}

/**
 * 
 * @param {number} telegramID 
 */
export function getUserByTelegramID(telegramID) {
    const row = getUserByTelegramIDStmt.get({ telegramID })
    if (!row || !row.telegram_id || !row.id) return null
    return new User(row.id, row.telegram_id)
}

/**
 * 
 * @param {User} user 
 * @param {string} access 
 */
export function addUserAccess(user, access) {
    addUserAccessStmt.run({ userID: user.id, accessTo: access })
}

/**
 * 
 * @param {User} user 
 * @param {string} access 
 */
export function removeUserAccess(user, access) {
    removeUserAccessStmt.run({ userID: user.id, accessTo: access })
}

/**
 * @param {User} user 
 */
export function flushUserAccess(user, access) {
    flushAllAccessStmt.run({ userID: user.id })
}

/**
 * @param {User} user 
 */
export function getUserAccessList(user) {

}

/**
 * 
 * @param {User} user 
 * @param {string} access 
 * @returns {boolean}
*/
export function checkAccess(user, access) {
    /**@type {{result: number}} */
    const row = userHasAccessToStmt.get({ userID: user.id, accessTo: access })
    return row.result === 1;
}