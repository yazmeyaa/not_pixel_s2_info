CREATE TABLE tournament_notification_reciever_old (
    chat_id INTEGER PRIMARY KEY NOT NULL
);
INSERT INTO tournament_notification_reciever_old (chat_id)
SELECT chat_id FROM tournament_notification_reciever;
DROP TABLE tournament_notification_reciever;
ALTER TABLE tournament_notification_reciever_old
RENAME TO tournament_notification_reciever;