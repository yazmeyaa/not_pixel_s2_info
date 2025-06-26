CREATE TABLE metrics_new (
    current_online INTEGER NOT NULL,
    bank_reward REAL NOT NULL,
    minted_pixels INTEGER,
    ts INTEGER PRIMARY KEY,
    data TEXT
);

INSERT INTO metrics_new (current_online, bank_reward, minted_pixels, ts, data)
SELECT current_online, bank_reward, minted_pixels, ts, data FROM metrics;

DROP TABLE metrics;
ALTER TABLE metrics_new RENAME TO metrics;