migrate-up:
	migrate -source file://migrations -database "sqlite3://db.sqlite" up

migrate-down:
	migrate -source file://migrations -database "sqlite3://db.sqlite" down

