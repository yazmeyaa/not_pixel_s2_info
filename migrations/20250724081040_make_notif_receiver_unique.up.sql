CREATE TABLE tournament_notification_receiver_new (
    chat_id INTEGER NOT NULL UNIQUE
);
INSERT INTO tournament_notification_receiver_new (chat_id)
SELECT chat_id FROM tournament_notification_reciever;
DROP TABLE tournament_notification_reciever;
ALTER TABLE tournament_notification_receiver_new
    RENAME TO tournament_notification_reciever;