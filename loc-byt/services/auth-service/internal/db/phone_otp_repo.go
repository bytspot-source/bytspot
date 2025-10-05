package db

import (
    "context"
    "time"
)

type PhoneOTP struct {
    ID        string
    Phone     string
    CodeHash  string
    Attempts  int
    ExpiresAt time.Time
    CreatedAt time.Time
}

func (s *Store) UpsertPhoneOTP(ctx context.Context, phone, codeHash string, ttl time.Duration) error {
    // Keep only one active row per phone by deleting older OTPs then inserting a new one
    _, _ = s.Pool.Exec(ctx, `DELETE FROM phone_otp WHERE phone=$1`, phone)
    expires := time.Now().Add(ttl)
    _, err := s.Pool.Exec(ctx, `INSERT INTO phone_otp (phone, code_hash, expires_at) VALUES ($1, $2, $3)`, phone, codeHash, expires)
    return err
}

func (s *Store) GetPhoneOTP(ctx context.Context, phone string) (*PhoneOTP, error) {
    row := s.Pool.QueryRow(ctx, `SELECT id, phone, code_hash, attempts, expires_at, created_at FROM phone_otp WHERE phone=$1`, phone)
    var o PhoneOTP
    if err := row.Scan(&o.ID, &o.Phone, &o.CodeHash, &o.Attempts, &o.ExpiresAt, &o.CreatedAt); err != nil {
        return nil, err
    }
    return &o, nil
}

func (s *Store) IncrementOTPAttempts(ctx context.Context, id string) error {
    _, err := s.Pool.Exec(ctx, `UPDATE phone_otp SET attempts = attempts + 1 WHERE id=$1`, id)
    return err
}

func (s *Store) DeletePhoneOTP(ctx context.Context, id string) error {
    _, err := s.Pool.Exec(ctx, `DELETE FROM phone_otp WHERE id=$1`, id)
    return err
}

