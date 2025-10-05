package main

import (
	"context"
	"os"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

// optional: run with `go run ./cmd/auth-service migrate`
func runMigrations() error {
	conn := os.Getenv("DATABASE_URL")
	if conn == "" {
		return nil
	}
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	db, err := goose.OpenDBWithDriver("postgres", conn)
	if err != nil {
		return err
	}
	defer db.Close()
	ctx := context.Background()

	// Determine migrations directory (local dev vs container image)
	dir := os.Getenv("MIGRATIONS_DIR")
	if dir == "" {
		if _, statErr := os.Stat("migrations"); statErr == nil {
			dir = "migrations"
		} else {
			dir = "/migrations"
		}
	}
	if err := goose.UpContext(ctx, db, dir); err != nil {
		return err
	}
	return nil
}
