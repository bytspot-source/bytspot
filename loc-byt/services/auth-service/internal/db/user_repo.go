package db

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type User struct {
	ID              string
	Email           string
	PasswordHash    string
	Name            *string
	Phone           *string
	IsEmailVerified bool
	Roles           []string
	Provider        string
	TokenVersion    int
	Metadata        map[string]any
	LastLoginAt     *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

type AdminAudit struct {
	ID          string
	ActorID     string
	TargetEmail string
	Action      string
	Reason      *string
	CreatedAt   time.Time
}

var ErrDuplicateEmail = errors.New("duplicate_email")

func (s *Store) CreateUser(ctx context.Context, u *User) error {
	q := `INSERT INTO users (email, password_hash, name, phone, is_email_verified, roles, provider, token_version, metadata)
		VALUES (lower($1), $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id, created_at, updated_at`
	err := s.Pool.QueryRow(ctx, q, u.Email, u.PasswordHash, u.Name, u.Phone, u.IsEmailVerified, u.Roles, u.Provider, u.TokenVersion, u.Metadata).
		Scan(&u.ID, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" { // unique_violation
			return ErrDuplicateEmail
		}
		return err
	}
	return nil
}

func (s *Store) CreateUserPhoneOnly(ctx context.Context, phone string) (*User, error) {
	u := &User{Phone: &phone, Roles: []string{"user"}, Provider: "phone", TokenVersion: 1}
	err := s.Pool.QueryRow(ctx,
		`INSERT INTO users (phone, roles, provider, token_version) VALUES ($1, $2, $3, $4) RETURNING id, created_at, updated_at`,
		phone, u.Roles, u.Provider, u.TokenVersion,
	).Scan(&u.ID, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return u, nil
}

func (s *Store) GetUserByPhone(ctx context.Context, phone string) (*User, error) {
	q := `SELECT id, email, password_hash, name, phone, is_email_verified, roles, provider, token_version, metadata, last_login_at, created_at, updated_at
		FROM users WHERE phone = $1`
	row := s.Pool.QueryRow(ctx, q, phone)
	u := &User{}
	var metadataBytes []byte
	if err := row.Scan(&u.ID, &u.Email, &u.PasswordHash, &u.Name, &u.Phone, &u.IsEmailVerified, &u.Roles, &u.Provider, &u.TokenVersion, &metadataBytes, &u.LastLoginAt, &u.CreatedAt, &u.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return u, nil
}

func (s *Store) GetUserByEmail(ctx context.Context, email string) (*User, error) {
	q := `SELECT id, email, password_hash, name, phone, is_email_verified, roles, provider, token_version, metadata, last_login_at, created_at, updated_at
		FROM users WHERE lower(email) = lower($1)`
	row := s.Pool.QueryRow(ctx, q, email)
	u := &User{}
	var metadataBytes []byte
	if err := row.Scan(&u.ID, &u.Email, &u.PasswordHash, &u.Name, &u.Phone, &u.IsEmailVerified, &u.Roles, &u.Provider, &u.TokenVersion, &metadataBytes, &u.LastLoginAt, &u.CreatedAt, &u.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return u, nil
}

func (s *Store) UpdateLastLogin(ctx context.Context, id string, t time.Time) error {
	_, err := s.Pool.Exec(ctx, `UPDATE users SET last_login_at=$1 WHERE id=$2`, t, id)
	return err
}

func (s *Store) PromoteAdminByEmail(ctx context.Context, email string) error {
	q := `UPDATE users SET roles = (SELECT ARRAY(SELECT DISTINCT UNNEST(roles || '{admin}'))) WHERE lower(email) = lower($1)`
	_, err := s.Pool.Exec(ctx, q, email)
	return err
}

func (s *Store) DemoteAdminByEmail(ctx context.Context, email string) error {
	q := `UPDATE users SET roles = ARRAY(SELECT UNNEST(roles) EXCEPT SELECT 'admin') WHERE lower(email) = lower($1)`
	_, err := s.Pool.Exec(ctx, q, email)
	return err
}

func (s *Store) InsertAdminAudit(ctx context.Context, actorID, targetEmail, action, reason string) error {
	q := `INSERT INTO admin_audit(actor_id, target_email, action, reason) VALUES ($1, lower($2), $3, $4)`
	_, err := s.Pool.Exec(ctx, q, actorID, targetEmail, action, reason)
	return err
}

func (s *Store) ListAdminAudit(ctx context.Context, limit int) ([]AdminAudit, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.Pool.Query(ctx, `SELECT id, actor_id, target_email, action, reason, created_at FROM admin_audit ORDER BY created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AdminAudit
	for rows.Next() {
		var a AdminAudit
		var reason *string
		if err := rows.Scan(&a.ID, &a.ActorID, &a.TargetEmail, &a.Action, &reason, &a.CreatedAt); err != nil {
			return nil, err
		}
		a.Reason = reason
		out = append(out, a)
	}
	return out, rows.Err()
}
