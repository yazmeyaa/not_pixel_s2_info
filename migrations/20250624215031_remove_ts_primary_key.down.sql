ALTER TABLE metrics RENAME TO metrics_new;

CREATE TABLE metrics (
    current_online INTEGER NOT NULL,
    bank_reward REAL NOT NULL,
    minted_pixels INTEGER NOT NULL,
    ts INTEGER PRIMARY KEY,
    data TEXT
);

INSERT INTO metrics (current_online, bank_reward, minted_pixels, ts, data)
SELECT current_online, bank_reward, minted_pixels, ts, data FROM metrics_new;

DROP TABLE metrics_new;