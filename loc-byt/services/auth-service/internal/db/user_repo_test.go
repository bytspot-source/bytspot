package db

import (
	"context"
	"os"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

func TestUserRepo_CreateAndGet(t *testing.T) {
	conn := os.Getenv("DATABASE_URL")
	if conn == "" {
		t.Skip("DATABASE_URL not set; skipping DB test")
	}

	// Ensure migrations are up on the test DB
	db, err := goose.OpenDBWithDriver("pgx", conn)
	if err != nil { t.Fatalf("goose open: %v", err) }
	defer db.Close()
	if err := goose.SetDialect("postgres"); err != nil { t.Fatalf("goose dialect: %v", err) }
	if err := goose.Up(db, "../../../services/auth-service/migrations"); err != nil { t.Fatalf("goose up: %v", err) }

	ctx := context.Background()
	store, err := New(ctx)
	if err != nil { t.Fatalf("store: %v", err) }
	defer store.Close()

	u := &User{Email: "testuser@example.com", PasswordHash: "argon2id$dummy$dummy", Provider: "local", Roles: []string{"user"}, TokenVersion: 1}
	if err := store.CreateUser(ctx, u); err != nil { t.Fatalf("create user: %v", err) }
	if u.ID == "" { t.Fatalf("expected id set") }

	u2, err := store.GetUserByEmail(ctx, "testuser@example.com")
	if err != nil { t.Fatalf("get user: %v", err) }
	if u2 == nil || u2.ID != u.ID { t.Fatalf("expected same user, got %+v", u2) }

	if err := store.UpdateLastLogin(ctx, u.ID, time.Now()); err != nil { t.Fatalf("update last login: %v", err) }
}

