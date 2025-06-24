ALTER TABLE metrics RENAME TO metrics_old;

CREATE TABLE metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    current_online INTEGER NOT NULL,
    bank_reward REAL NOT NULL,
    minted_pixels INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    data TEXT
);

INSERT INTO metrics (current_online, bank_reward, minted_pixels, ts, data)
SELECT current_online, bank_reward, minted_pixels, ts, data FROM metrics_old;

DROP TABLE metrics_old;