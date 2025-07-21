migrate-up:
	migrate -source file://migrations -database "sqlite3://db.sqlite" up $(n)

migrate-down:
	migrate -source file://migrations -database "sqlite3://db.sqlite" down $(n)

migrate-force:
	migrate -source file://migrations -database "sqlite3://db.sqlite" force $(version)