package db

import (
	"context"
)

type HostOnboarding struct {
	UserID     string
	ServiceType *string
	Data       map[string]any
	Progress   int
}

func (s *Store) UpsertHostOnboarding(ctx context.Context, userID string, serviceType *string, data map[string]any, progress int) error {
	q := `INSERT INTO host_onboarding (user_id, service_type, data, progress)
	      VALUES ($1, $2, $3, $4)
	      ON CONFLICT (user_id) DO UPDATE SET service_type=EXCLUDED.service_type, data=EXCLUDED.data, progress=EXCLUDED.progress`
	_, err := s.Pool.Exec(ctx, q, userID, serviceType, data, progress)
	return err
}

func (s *Store) GetHostOnboarding(ctx context.Context, userID string) (*HostOnboarding, error) {
	q := `SELECT user_id, service_type, data, progress FROM host_onboarding WHERE user_id=$1`
	row := s.Pool.QueryRow(ctx, q, userID)
	h := &HostOnboarding{}
	if err := row.Scan(&h.UserID, &h.ServiceType, &h.Data, &h.Progress); err != nil {
		return nil, err
	}
	return h, nil
}

