CREATE TABLE user(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE NOT NULL
);

CREATE TABLE user_access(
    user_id INTEGER NOT NULL,
    access_to TEXT,
    PRIMARY KEY (user_id, access_to),
    FOREIGN KEY(user_id) REFERENCES user(id)
);