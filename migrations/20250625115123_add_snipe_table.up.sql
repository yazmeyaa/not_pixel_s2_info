CREATE TABLE snipe_target_pixel (
    target_wallet VARCHAR(36) NOT NULL,
    nft_item_address VARCHAR(36) NOT NULL,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    price INTEGER NOT NULL
);
CREATE INDEX idx_snipe_target_pixel_wallet ON snipe_target_pixel (target_wallet);