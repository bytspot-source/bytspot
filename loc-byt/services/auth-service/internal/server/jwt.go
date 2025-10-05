package server

import (
	"errors"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type jwtCustomClaims struct {
	Sub   string   `json:"sub"`
	Roles []string `json:"roles,omitempty"`
	jwt.RegisteredClaims
}

func jwtSecret() []byte {
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		// Development fallback only; set JWT_SECRET in prod
		secret = "dev_secret_change_me"
	}
	return []byte(secret)
}

func signToken(subject string, roles []string, ttl time.Duration) (string, int64, error) {
	exp := time.Now().Add(ttl)
	claims := jwtCustomClaims{
		Sub:   subject,
		Roles: roles,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(exp),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString(jwtSecret())
	if err != nil {
		return "", 0, err
	}
	return signed, exp.Unix(), nil
}

func verifyToken(tokenString string) (*jwtCustomClaims, error) {
	tok, err := jwt.ParseWithClaims(tokenString, &jwtCustomClaims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return jwtSecret(), nil
	})
	if err != nil {
		return nil, err
	}
	if claims, ok := tok.Claims.(*jwtCustomClaims); ok && tok.Valid {
		return claims, nil
	}
	return nil, errors.New("invalid token")
}

